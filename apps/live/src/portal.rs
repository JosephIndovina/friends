//! Wayland screen capture through the xdg-desktop-portal ScreenCast API, done by hand rather than through
//! WebRTC's capturer so that (1) the choice is remembered ("persist until revoked") and the picker only shows
//! the first time, and (2) we learn the picked window's title, which is how its sound is found.

use anyhow::{anyhow, Context, Result};
use ashpd::desktop::screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType};
use ashpd::desktop::PersistMode;
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::prelude::*;
use livekit::webrtc::video_source::native::NativeVideoSource;
use pipewire as pw;
use pw::spa;
use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::time::{Duration, Instant};

/// What the user shared.
pub struct Picked {
    pub node_id: u32,
    fd: Option<OwnedFd>,
    pub size: Option<(i32, i32)>,
    pub is_window: bool,
    /// Hand this back next time to skip the picker.
    pub restore_token: Option<String>,
    /// For a window: its title as GNOME recorded it (from the portal's permission store). The portal doesn't
    /// say which app owns a window, so the title is what the sound is matched by.
    pub title: Option<String>,
    // Keeps the portal session (and so the stream) open.
    _session: ashpd::desktop::Session<Screencast>,
    _proxy: Screencast,
}

/// Opens the system picker, or reuses the last choice silently when `restore` is still valid.
pub async fn pick(restore: Option<&str>) -> Result<Picked> {
    let proxy = Screencast::new().await.context("the screen sharing portal isn't available")?;
    let session = proxy.create_session(Default::default()).await?;
    proxy
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                .set_cursor_mode(CursorMode::EMBEDDED)
                .set_sources(SourceType::WINDOW | SourceType::MONITOR)
                .set_multiple(false)
                .set_persist_mode(PersistMode::ExplicitlyRevoked)
                .set_restore_token(restore),
        )
        .await?
        .response()?;
    let streams = proxy
        .start(&session, None, Default::default())
        .await?
        .response()
        .map_err(|e| anyhow!("capture cancelled ({e})"))?;
    let stream = streams.streams().first().ok_or_else(|| anyhow!("capture cancelled (no stream)"))?;
    let node_id = stream.pipe_wire_node_id();
    let size = stream.size();
    let is_window = stream.source_type() == Some(SourceType::WINDOW);
    let restore_token = streams.restore_token().map(str::to_string);
    let fd = proxy.open_pipe_wire_remote(&session, Default::default()).await?;

    let title = match (&restore_token, is_window) {
        (Some(t), true) => window_title(t).await.unwrap_or_else(|e| {
            log::warn!("couldn't read the shared window's title: {e:#}");
            None
        }),
        _ => None,
    };
    Ok(Picked { node_id, fd: Some(fd), size, is_window, restore_token, title, _session: session, _proxy: proxy })
}

/// The portal keeps what it needs to restore a choice in the permission store, keyed by the restore token.
/// GNOME stores ("GNOME", 1, <(…, [(…, <("window:<id>", "<title>")>)])>) for a window.
pub async fn window_title(token: &str) -> Result<Option<String>> {
    use ashpd::zbus::OwnedVariant;
    use std::collections::HashMap;
    let conn = ashpd::zbus::Connection::session().await?;
    let reply = conn
        .call_method(
            Some("org.freedesktop.impl.portal.PermissionStore"),
            "/org/freedesktop/impl/portal/PermissionStore",
            Some("org.freedesktop.impl.portal.PermissionStore"),
            "Lookup",
            &("screencast", token),
        )
        .await?;
    let (_perms, data): (HashMap<String, Vec<String>>, OwnedVariant) = reply.body().deserialize()?;
    let mut strings = Vec::new();
    collect_strings(&data, &mut strings);
    log::debug!("restore data strings: {strings:?}");
    let i = strings.iter().position(|s| s.starts_with("window:"));
    Ok(i.and_then(|i| strings.get(i + 1)).filter(|t| !t.is_empty()).cloned())
}

fn collect_strings(v: &ashpd::zbus::Variant<'_>, out: &mut Vec<String>) {
    use ashpd::zbus::Variant as V;
    match v {
        V::Str(s) => out.push(s.to_string()),
        V::Variant(inner) => collect_strings(inner, out),
        V::Structure(s) => s.fields().iter().for_each(|f| collect_strings(f, out)),
        V::Array(a) => a.iter().for_each(|f| collect_strings(f, out)),
        V::Dict(d) => d.iter().for_each(|(k, v)| {
            collect_strings(k, out);
            collect_strings(v, out);
        }),
        _ => {}
    }
}

/// A running window or screen capture. Dropping it stops the PipeWire thread.
pub struct Capture {
    quit: pw::channel::Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
    ended: Arc<AtomicBool>,
}

impl Capture {
    /// The window was closed or the OS ended the share.
    pub fn ended(&self) -> bool {
        self.ended.load(Ordering::Relaxed)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.quit.send(());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

struct Frames {
    format: spa::param::video::VideoInfoRaw,
    out: Arc<OnceLock<NativeVideoSource>>,
    first: Option<mpsc::Sender<Result<(u32, u32)>>>,
    min_gap: Duration,
    last: Option<Instant>,
    max_height: u32,
    ended: Arc<AtomicBool>,
    streaming: bool,
}

/// Reads frames from the portal's PipeWire stream into `out` at up to `fps`, scaled to fit `max_height`.
/// Returns once the first frame arrives, with its size.
pub fn start(picked: &mut Picked, fps: u32, max_height: u32, out: Arc<OnceLock<NativeVideoSource>>) -> Result<(Capture, u32, u32)> {
    let fd = picked.fd.take().ok_or_else(|| anyhow!("already capturing"))?;
    let node_id = picked.node_id;
    let (quit_tx, quit_rx) = pw::channel::channel::<()>();
    let (first_tx, first_rx) = mpsc::channel::<Result<(u32, u32)>>();
    let ended = Arc::new(AtomicBool::new(false));

    let thread = std::thread::Builder::new().name("pw-video".into()).spawn({
        let ended = ended.clone();
        move || {
            let err_tx = first_tx.clone();
            if let Err(e) = run(fd, node_id, fps, max_height, out, first_tx, ended, quit_rx) {
                let _ = err_tx.send(Err(e));
            }
        }
    })?;

    // Mutter sends a first frame right away; a window that never draws would otherwise hang Go live.
    let (w, h) = match first_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(r) => r?,
        Err(_) => return Err(anyhow!("the shared window didn't send a picture")),
    };
    Ok((Capture { quit: quit_tx, thread: Some(thread), ended }, w, h))
}

#[allow(clippy::too_many_arguments)]
fn run(
    fd: OwnedFd,
    node_id: u32,
    fps: u32,
    max_height: u32,
    out: Arc<OnceLock<NativeVideoSource>>,
    first_tx: mpsc::Sender<Result<(u32, u32)>>,
    ended: Arc<AtomicBool>,
    quit_rx: pw::channel::Receiver<()>,
) -> Result<()> {
    crate::audio::pipewire_init()?;
    let mainloop = pw::main_loop::MainLoopRc::new(None)?;
    let context = pw::context::ContextRc::new(&mainloop, None)?;
    let core = context.connect_fd_rc(fd, None)?;
    let _quit = quit_rx.attach(mainloop.loop_(), {
        let ml = mainloop.clone();
        move |_| ml.quit()
    });

    let stream = pw::stream::StreamBox::new(
        &core,
        "Friends Live video",
        pw::properties::properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    )?;
    let data = Frames {
        format: Default::default(),
        out,
        first: Some(first_tx),
        min_gap: Duration::from_secs_f64(0.95 / fps.max(1) as f64),
        last: None,
        max_height,
        ended,
        streaming: false,
    };
    let _listener = stream
        .add_local_listener_with_user_data(data)
        .state_changed(|_, d, _old, new| match new {
            pw::stream::StreamState::Streaming => d.streaming = true,
            pw::stream::StreamState::Error(e) => {
                log::warn!("screen capture error: {e}");
                d.ended.store(true, Ordering::Relaxed);
                if let Some(tx) = d.first.take() {
                    let _ = tx.send(Err(anyhow!("capture failed: {e}")));
                }
            }
            pw::stream::StreamState::Unconnected if d.streaming => d.ended.store(true, Ordering::Relaxed),
            _ => {}
        })
        .param_changed(|_, d, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            if let Err(e) = d.format.parse(param) {
                log::warn!("bad video format: {e:?}");
            }
        })
        .process(|stream, d| {
            let Some(mut buffer) = stream.dequeue_buffer() else { return };
            let now = Instant::now();
            if d.last.is_some_and(|t| now.duration_since(t) < d.min_gap) {
                return;
            }
            let datas = buffer.datas_mut();
            let Some(data) = datas.first_mut() else { return };
            let (offset, size, stride) = (data.chunk().offset() as usize, data.chunk().size() as usize, data.chunk().stride());
            if size == 0 {
                return; // a cursor-only update
            }
            let (w, h) = (d.format.size().width, d.format.size().height);
            let Some(bytes) = data.data() else { return };
            let stride = if stride > 0 { stride as u32 } else { w * 4 };
            if w == 0 || h == 0 || bytes.len() < offset + (stride * h) as usize {
                return;
            }
            let px = &bytes[offset..];
            let mut buf = I420Buffer::new(w, h);
            let (sy, su, sv) = buf.strides();
            let (y, u, v) = buf.data_mut();
            use spa::param::video::VideoFormat as F;
            match d.format.format() {
                // libyuv names formats by word order: its "ARGB" is B,G,R,A in memory.
                F::BGRx | F::BGRA => yuv_helper::argb_to_i420(px, stride, y, sy, u, su, v, sv, w as i32, h as i32),
                F::RGBx | F::RGBA => yuv_helper::abgr_to_i420(px, stride, y, sy, u, su, v, sv, w as i32, h as i32),
                other => {
                    log::warn!("unexpected video format {other:?}");
                    return;
                }
            }
            let buf = if h > d.max_height {
                let th = d.max_height & !1;
                let tw = ((w as u64 * th as u64 / h as u64) as u32) & !1;
                buf.scale(tw as i32, th as i32)
            } else {
                buf
            };
            d.last = Some(now);
            if let Some(tx) = d.first.take() {
                let _ = tx.send(Ok((buf.width(), buf.height())));
            }
            if let Some(src) = d.out.get() {
                src.capture_frame(&VideoFrame::new(VideoRotation::VideoRotation0, buf));
            }
        })
        .register()?;

    use spa::param::format::{FormatProperties as P, MediaSubtype, MediaType};
    use spa::param::video::VideoFormat as F;
    let obj = spa::pod::object!(
        spa::utils::SpaTypes::ObjectParamFormat,
        spa::param::ParamType::EnumFormat,
        spa::pod::property!(P::MediaType, Id, MediaType::Video),
        spa::pod::property!(P::MediaSubtype, Id, MediaSubtype::Raw),
        spa::pod::property!(P::VideoFormat, Choice, Enum, Id, F::BGRx, F::BGRx, F::BGRA, F::RGBx, F::RGBA),
        spa::pod::property!(
            P::VideoSize,
            Choice,
            Range,
            Rectangle,
            spa::utils::Rectangle { width: 1920, height: 1080 },
            spa::utils::Rectangle { width: 1, height: 1 },
            spa::utils::Rectangle { width: 8192, height: 8192 }
        ),
        spa::pod::property!(
            P::VideoFramerate,
            Choice,
            Range,
            Fraction,
            spa::utils::Fraction { num: fps, denom: 1 },
            spa::utils::Fraction { num: 0, denom: 1 },
            spa::utils::Fraction { num: 1000, denom: 1 }
        ),
    );
    let bytes = spa::pod::serialize::PodSerializer::serialize(std::io::Cursor::new(Vec::new()), &spa::pod::Value::Object(obj))
        .map_err(|e| anyhow!("pod: {e:?}"))?
        .0
        .into_inner();
    let mut params = [spa::pod::Pod::from_bytes(&bytes).ok_or_else(|| anyhow!("bad pod"))?];
    stream.connect(
        spa::utils::Direction::Input,
        Some(node_id),
        pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
        &mut params,
    )?;
    mainloop.run();
    Ok(())
}
