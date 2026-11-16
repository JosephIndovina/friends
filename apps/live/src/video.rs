//! Screen and window capture through WebRTC's own desktop capturer: Windows Graphics Capture on Windows,
//! the xdg-desktop-portal ScreenCast picker (and PipeWire) on Wayland.

// On Linux capture goes through the portal (portal.rs); this path is for Windows (and `sources`).
#![cfg_attr(target_os = "linux", allow(dead_code))]

use anyhow::{anyhow, Result};
use livekit::webrtc::desktop_capturer::{
    CaptureError, CaptureSource, DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions,
};
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::prelude::*;
use livekit::webrtc::video_source::native::NativeVideoSource;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Screen,
    Window,
    /// Wayland: the OS picker decides, screen or window.
    #[cfg(target_os = "linux")]
    Picker,
}

impl Kind {
    fn source_type(self) -> DesktopCaptureSourceType {
        match self {
            Kind::Screen => DesktopCaptureSourceType::Screen,
            Kind::Window => DesktopCaptureSourceType::Window,
            #[cfg(target_os = "linux")]
            Kind::Picker => DesktopCaptureSourceType::Generic,
        }
    }
}

/// On Wayland apps can't list windows or screens themselves; the portal's picker is the only way in.
pub fn needs_os_picker() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// The OS picker on Wayland, otherwise the whole screen.
pub fn default_kind() -> Kind {
    #[cfg(target_os = "linux")]
    if needs_os_picker() {
        return Kind::Picker;
    }
    Kind::Screen
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Source {
    pub id: u64,
    pub title: String,
}

pub fn list(kind: Kind) -> Result<Vec<Source>> {
    let capturer =
        DesktopCapturer::new(DesktopCapturerOptions::new(kind.source_type())).ok_or_else(|| anyhow!("no capturer"))?;
    Ok(capturer.get_source_list().into_iter().map(|s| Source { id: s.id(), title: s.title() }).collect())
}

pub struct Capture {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// The first frame's size, so the track can be published with the right dimensions.
pub struct Started {
    pub capture: Capture,
    pub width: u32,
    pub height: u32,
}

/// Starts capturing `source` (None = the OS picker) at up to `fps`, scaled down to fit `max_height`,
/// feeding frames into `out`. Returns once the first frame arrives, or errors if the user cancels the picker.
pub fn start(kind: Kind, source: Option<u64>, fps: u32, max_height: u32, out: Arc<OnceLock<NativeVideoSource>>) -> Result<Started> {
    let stop = Arc::new(AtomicBool::new(false));
    let (first_tx, first_rx) = mpsc::channel::<Result<(u32, u32)>>();

    let thread = std::thread::Builder::new().name("video-capture".into()).spawn({
        let stop = stop.clone();
        move || {
            let mut opts = DesktopCapturerOptions::new(kind.source_type());
            opts.set_include_cursor(true);
            let Some(mut capturer) = DesktopCapturer::new(opts) else {
                let _ = first_tx.send(Err(anyhow!("couldn't start screen capture")));
                return;
            };
            let chosen: Option<CaptureSource> =
                source.and_then(|id| capturer.get_source_list().into_iter().find(|s| s.id() == id));
            if source.is_some() && chosen.is_none() {
                let _ = first_tx.send(Err(anyhow!("that window or screen is gone")));
                return;
            }

            let mut first = Some(first_tx);
            let stop_cb = stop.clone();
            capturer.start_capture(chosen, move |res| match res {
                Ok(frame) => {
                    let (w, h) = (frame.width() as u32, frame.height() as u32);
                    if w == 0 || h == 0 {
                        return;
                    }
                    let buf = to_i420(frame.data(), frame.stride(), w, h, max_height);
                    if let Some(tx) = first.take() {
                        let _ = tx.send(Ok((buf.width(), buf.height())));
                    }
                    // Frames before the track exists (sized from this first one) are dropped.
                    if let Some(src) = out.get() {
                        src.capture_frame(&VideoFrame::new(VideoRotation::VideoRotation0, buf));
                    }
                }
                Err(CaptureError::Temporary) => {}
                Err(CaptureError::Permanent) => {
                    // Picker cancelled, window closed, or the portal session ended.
                    if let Some(tx) = first.take() {
                        let _ = tx.send(Err(anyhow!("capture cancelled")));
                    }
                    stop_cb.store(true, Ordering::Relaxed);
                }
            });

            // The capturer is pull-based: ask for a frame every tick.
            let tick = Duration::from_secs_f64(1.0 / fps.max(1) as f64);
            let mut next = Instant::now();
            while !stop.load(Ordering::Relaxed) {
                capturer.capture_frame();
                next += tick;
                let now = Instant::now();
                if next > now {
                    std::thread::sleep(next - now);
                } else {
                    next = now;
                }
            }
        }
    })?;

    // The portal picker waits on the user, so no timeout here.
    let (width, height) = first_rx.recv().map_err(|_| anyhow!("capture thread died"))??;
    Ok(Started { capture: Capture { stop, thread: Some(thread) }, width, height })
}

/// BGRA → I420, scaled down (never up) so the height fits.
fn to_i420(bgra: &[u8], stride: u32, w: u32, h: u32, max_height: u32) -> I420Buffer {
    let mut full = I420Buffer::new(w, h);
    let (sy, su, sv) = full.strides();
    let (y, u, v) = full.data_mut();
    // libyuv's "ARGB" is BGRA in memory, which is what desktop frames are.
    yuv_helper::argb_to_i420(bgra, stride, y, sy, u, su, v, sv, w as i32, h as i32);
    if h <= max_height {
        return full;
    }
    let th = max_height & !1;
    let tw = ((w as u64 * th as u64 / h as u64) as u32) & !1;
    full.scale(tw as i32, th as i32)
}
