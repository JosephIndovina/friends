//! App audio on Linux: every app's playback is its own PipeWire stream node, so capturing one app is just
//! recording from its nodes. The app keeps playing to its speakers; we're one more listener.

use super::{AudioApp, Mixer, CHANNELS, SAMPLE_RATE};
use anyhow::{anyhow, Result};
use pipewire as pw;
use pw::{properties::properties, spa};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::{mpsc, Arc};

unsafe extern "C" {
    /// `bool webrtc::InitializePipeWire()`. libwebrtc carries weak `pw_*` stubs (it loads PipeWire lazily), and
    /// they win over the real libpipewire at link time; until this runs they're null pointers.
    #[link_name = "_ZN6webrtc18InitializePipeWireEv"]
    fn webrtc_initialize_pipewire() -> bool;
}

pub fn init() -> Result<()> {
    static LOADED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if !*LOADED.get_or_init(|| unsafe { webrtc_initialize_pipewire() }) {
        return Err(anyhow!("PipeWire isn't available"));
    }
    pw::init();
    Ok(())
}

/// Apps currently holding an audio output stream, grouped by process so a browser's many tabs show once.
pub fn list_apps() -> Result<Vec<AudioApp>> {
    init()?;
    let mainloop = pw::main_loop::MainLoopRc::new(None)?;
    let context = pw::context::ContextRc::new(&mainloop, None)?;
    let core = context.connect_rc(None)?;
    let registry = core.get_registry_rc()?;

    let apps: Rc<RefCell<BTreeMap<String, AudioApp>>> = Rc::default();
    let done = Rc::new(Cell::new(false));
    let pending = core.sync(0)?;

    let _reg = registry
        .add_listener_local()
        .global({
            let apps = apps.clone();
            move |g| {
                if g.type_ != pw::types::ObjectType::Node {
                    return;
                }
                let Some(props) = g.props else { return };
                if props.get("media.class") != Some("Stream/Output/Audio") {
                    return;
                }
                let raw = props.get("application.name").or_else(|| props.get("node.name")).unwrap_or("Unknown");
                // ALSA apps routed through PipeWire show up as "PipeWire ALSA [game]".
                let name = raw
                    .strip_prefix("PipeWire ALSA [")
                    .and_then(|s| s.strip_suffix(']'))
                    .unwrap_or(raw)
                    .to_string();
                let pid = props.get("application.process.id").map(str::to_string);
                let binary = props.get("application.process.binary").map(str::to_string);
                // Group by process; fall back to the app name when the stream doesn't say which process it is.
                let key = pid.clone().unwrap_or_else(|| format!("name:{name}"));
                let serial = props.get("object.serial").unwrap_or_default().to_string();
                let mut apps = apps.borrow_mut();
                let entry = apps.entry(key.clone()).or_insert_with(|| AudioApp {
                    id: key,
                    name,
                    binary,
                    targets: Vec::new(),
                });
                entry.targets.push(if serial.is_empty() { g.id.to_string() } else { serial });
            }
        })
        .register();

    let _core = core
        .add_listener_local()
        .done({
            let done = done.clone();
            let ml = mainloop.clone();
            move |id, seq| {
                if id == pw::core::PW_ID_CORE && seq == pending {
                    done.set(true);
                    ml.quit();
                }
            }
        })
        .register();

    while !done.get() {
        mainloop.run();
    }
    let list = apps.borrow().values().cloned().collect();
    Ok(list)
}

/// Handle to a running capture; dropping it stops the PipeWire thread.
pub struct Capture {
    quit: pw::channel::Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.quit.send(());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Records every stream of `app` into `mixer`, one input per stream, at 48 kHz stereo f32.
pub fn capture(app: &AudioApp, mixer: Arc<Mixer>) -> Result<Capture> {
    let targets = app.targets.clone();
    let (quit_tx, quit_rx) = pw::channel::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<()>>();

    let thread = std::thread::Builder::new().name("pw-audio".into()).spawn(move || {
        let run = || -> Result<()> {
            init()?;
            let mainloop = pw::main_loop::MainLoopRc::new(None)?;
            let context = pw::context::ContextRc::new(&mainloop, None)?;
            let core = context.connect_rc(None)?;

            let _quit = quit_rx.attach(mainloop.loop_(), {
                let ml = mainloop.clone();
                move |_| ml.quit()
            });

            let mut keep = Vec::new();
            for (i, target) in targets.iter().enumerate() {
                let input = mixer.add_input();
                let props = properties! {
                    *pw::keys::MEDIA_TYPE => "Audio",
                    *pw::keys::MEDIA_CATEGORY => "Capture",
                    *pw::keys::MEDIA_ROLE => "Music",
                    *pw::keys::TARGET_OBJECT => target.as_str(),
                    // If the app closes this stream, don't wander off and record something else.
                    *pw::keys::NODE_DONT_RECONNECT => "true",
                    *pw::keys::NODE_NAME => format!("friends-live-{i}"),
                };
                let stream = pw::stream::StreamBox::new(&core, "Friends stream audio", props)?;
                let listener = stream
                    .add_local_listener_with_user_data(input)
                    .process(|stream, input| {
                        let Some(mut buffer) = stream.dequeue_buffer() else { return };
                        let datas = buffer.datas_mut();
                        let Some(d) = datas.first_mut() else { return };
                        let size = d.chunk().size() as usize;
                        let offset = d.chunk().offset() as usize;
                        if let Some(bytes) = d.data() {
                            let bytes = &bytes[offset..(offset + size).min(bytes.len())];
                            let samples: Vec<f32> =
                                bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
                            input.push(&samples);
                        }
                    })
                    .register()?;

                // Ask for 48 kHz stereo float; PipeWire converts whatever the app plays.
                let mut info = spa::param::audio::AudioInfoRaw::new();
                info.set_format(spa::param::audio::AudioFormat::F32LE);
                info.set_rate(SAMPLE_RATE);
                info.set_channels(CHANNELS);
                let mut pos = [0u32; spa::param::audio::MAX_CHANNELS];
                pos[0] = libspa_sys_fl();
                pos[1] = libspa_sys_fr();
                info.set_position(pos);
                let obj = spa::pod::Object {
                    type_: spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
                    id: spa::param::ParamType::EnumFormat.as_raw(),
                    properties: info.into(),
                };
                let bytes = spa::pod::serialize::PodSerializer::serialize(
                    std::io::Cursor::new(Vec::new()),
                    &spa::pod::Value::Object(obj),
                )
                .map_err(|e| anyhow!("pod: {e:?}"))?
                .0
                .into_inner();
                let mut params = [spa::pod::Pod::from_bytes(&bytes).ok_or_else(|| anyhow!("bad pod"))?];
                stream.connect(
                    spa::utils::Direction::Input,
                    None,
                    pw::stream::StreamFlags::AUTOCONNECT
                        | pw::stream::StreamFlags::MAP_BUFFERS
                        | pw::stream::StreamFlags::RT_PROCESS,
                    &mut params,
                )?;
                keep.push((stream, listener));
            }
            let _ = ready_tx.send(Ok(()));
            mainloop.run();
            drop(keep);
            Ok(())
        };
        if let Err(e) = run() {
            let _ = ready_tx.send(Err(e));
        }
    })?;

    ready_rx.recv().map_err(|_| anyhow!("audio thread died"))??;
    Ok(Capture { quit: quit_tx, thread: Some(thread) })
}

fn libspa_sys_fl() -> u32 {
    pw::spa::sys::SPA_AUDIO_CHANNEL_FL
}
fn libspa_sys_fr() -> u32 {
    pw::spa::sys::SPA_AUDIO_CHANNEL_FR
}
