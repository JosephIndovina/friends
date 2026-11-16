//! Friends Live: streams a screen or window plus one app's audio to the stage.
//! With no arguments (or a friends:// link) it opens the app window; the subcommands are for testing.

#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod audio;
mod gui;
#[cfg(target_os = "linux")]
mod portal;
mod session;
mod tray;
mod video;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use livekit::options::{VideoCodec, VideoEncoderBackend};
use livekit::prelude::RoomEvent;
use std::sync::Arc;
use std::time::Duration;

#[derive(Parser)]
#[command(name = "friends-live")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Apps that are playing audio right now.
    Apps,
    /// Screens or windows that can be shared (not on Wayland; the OS picker is used there).
    Sources {
        #[arg(long, value_enum, default_value_t = KindArg::Window)]
        kind: KindArg,
    },
    /// Go live without the app window.
    Stream(StreamArgs),
    /// Open the screen picker and show what was picked (Linux).
    Pick {
        #[arg(long)]
        restore: Option<String>,
    },
    /// Join as a viewer and print how loud each stream's sound is (for checking audio end to end).
    Listen {
        #[arg(long)]
        url: String,
        #[arg(long)]
        token: String,
        #[arg(long, default_value_t = 15)]
        seconds: u64,
    },
    /// Record an app's audio to a WAV file (for checking capture without a server).
    Record {
        #[arg(long)]
        app: String,
        #[arg(long, default_value_t = 5)]
        seconds: u32,
        #[arg(long, default_value = "capture.wav")]
        out: std::path::PathBuf,
    },
}

#[derive(Parser)]
struct StreamArgs {
    /// LiveKit URL, e.g. wss://example.com/livekit
    #[arg(long)]
    url: String,
    #[arg(long)]
    token: String,
    /// Reuse a window picked before (the token `pick` or a previous stream printed) instead of asking.
    #[arg(long)]
    restore: Option<String>,
    #[arg(long, default_value_t = 60)]
    fps: u32,
    /// Largest height; bigger sources are scaled down, never up.
    #[arg(long, default_value_t = 1080)]
    height: u32,
    #[arg(long, default_value_t = 8000)]
    kbps: u64,
    #[arg(long, value_enum, default_value_t = CodecArg::Vp8)]
    codec: CodecArg,
    #[arg(long, value_enum, default_value_t = EncoderArg::Auto)]
    encoder: EncoderArg,
    /// "motion" keeps the frame rate up when bandwidth drops; "detail" keeps the resolution.
    #[arg(long, value_enum, default_value_t = HintArg::Motion)]
    hint: HintArg,
}

#[derive(Clone, Copy, ValueEnum)]
enum KindArg {
    Screen,
    Window,
    #[cfg(target_os = "linux")]
    Picker,
}

impl From<KindArg> for video::Kind {
    fn from(k: KindArg) -> Self {
        match k {
            KindArg::Screen => video::Kind::Screen,
            KindArg::Window => video::Kind::Window,
            #[cfg(target_os = "linux")]
            KindArg::Picker => video::Kind::Picker,
        }
    }
}

#[derive(Clone, Copy, ValueEnum)]
enum CodecArg {
    Vp8,
    H264,
}

#[derive(Clone, Copy, ValueEnum)]
enum EncoderArg {
    Auto,
    Software,
    Hardware,
    Nvenc,
    Vaapi,
}

#[derive(Clone, Copy, ValueEnum)]
enum HintArg {
    Motion,
    Detail,
}

const COMMANDS: &[&str] = &["apps", "listen", "pick", "sources", "stream", "record", "help", "--help", "-h", "--version", "-V"];

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info,libwebrtc=warn")).init();
    let first = std::env::args().nth(1);
    if first.as_deref().is_some_and(|a| COMMANDS.contains(&a)) {
        return tokio::runtime::Runtime::new()?.block_on(cli(Cli::parse()));
    }
    gui::run();
    Ok(())
}

async fn cli(c: Cli) -> Result<()> {
    match c.cmd {
        Cmd::Apps => {
            let apps = tokio::task::spawn_blocking(audio::list_apps).await??;
            println!("{}", serde_json::to_string_pretty(&apps)?);
        }
        Cmd::Sources { kind } => {
            if video::needs_os_picker() {
                bail!("Wayland doesn't let apps list windows; `stream` opens the system picker instead");
            }
            let list = tokio::task::spawn_blocking(move || video::list(kind.into())).await??;
            println!("{}", serde_json::to_string_pretty(&list)?);
        }
        Cmd::Stream(a) => stream(a).await?,
        Cmd::Listen { url, token, seconds } => listen(&url, &token, seconds).await?,
        #[cfg(target_os = "linux")]
        Cmd::Pick { restore } => {
            let p = portal::pick(restore.as_deref()).await?;
            println!("node {} size {:?} window {} token {:?} title {:?}", p.node_id, p.size, p.is_window, p.restore_token, p.title);
        }
        #[cfg(not(target_os = "linux"))]
        Cmd::Pick { .. } => bail!("Linux only"),
        Cmd::Record { app, seconds, out } => {
            let app = find_app(&app).await?;
            let mixer = Arc::new(audio::Mixer::default());
            let cap = audio::capture(&app, mixer.clone())?;
            let mut pcm: Vec<i16> = Vec::new();
            let mut tick = tokio::time::interval(Duration::from_millis(10));
            for _ in 0..seconds * 100 {
                tick.tick().await;
                pcm.extend(mixer.next_frame());
            }
            drop(cap);
            let peak = pcm.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);
            std::fs::write(&out, wav(&pcm))?;
            println!("wrote {} ({} s, peak {:.1}%)", out.display(), seconds, peak as f64 / i16::MAX as f64 * 100.0);
        }
    }
    Ok(())
}

async fn stream(a: StreamArgs) -> Result<()> {
    let opts = session::Options {
        restore: a.restore,
        fps: a.fps,
        height: a.height,
        kbps: a.kbps,
        hint: match a.hint {
            HintArg::Motion => session::Hint::Motion,
            HintArg::Detail => session::Hint::Detail,
        },
        codec: match a.codec {
            CodecArg::Vp8 => VideoCodec::VP8,
            CodecArg::H264 => VideoCodec::H264,
        },
        encoder: match a.encoder {
            EncoderArg::Auto => VideoEncoderBackend::Auto,
            EncoderArg::Software => VideoEncoderBackend::Software,
            EncoderArg::Hardware => VideoEncoderBackend::Hardware,
            EncoderArg::Nvenc => VideoEncoderBackend::Nvenc,
            EncoderArg::Vaapi => VideoEncoderBackend::Vaapi,
        },
    };
    let (s, mut events) = session::Session::start(&a.url, &a.token, opts).await?;
    println!("live: {} {}x{} window {:?}  (Ctrl-C to stop)", s.name, s.width, s.height, s.window);
    if let Some(t) = &s.restore_token {
        println!("reuse this window next time with --restore {t}");
    }
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut sound = None;
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = tick.tick() => {
                if s.capture_ended() {
                    log::info!("the shared window went away");
                    break;
                }
                let now = s.sound_from();
                if now != sound {
                    println!("sound: {}", now.as_deref().unwrap_or("none"));
                    sound = now;
                }
            }
            ev = events.recv() => match ev {
                Some(RoomEvent::Disconnected { reason }) => {
                    log::info!("stream ended: {reason:?}");
                    break;
                }
                None => break,
                _ => {}
            },
        }
    }
    s.stop().await;
    Ok(())
}

async fn listen(url: &str, token: &str, seconds: u64) -> Result<()> {
    use futures_util::StreamExt;
    use livekit::prelude::*;
    use livekit::webrtc::audio_stream::native::NativeAudioStream;
    let (_room, mut events) = Room::connect(url, token, RoomOptions::default()).await?;
    let deadline = tokio::time::sleep(Duration::from_secs(seconds));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            ev = events.recv() => match ev {
                Some(RoomEvent::TrackSubscribed { track: RemoteTrack::Audio(t), publication, participant }) => {
                    let label = format!("{} {}", participant.identity(), publication.name());
                    println!("subscribed {label}");
                    tokio::spawn(async move {
                        let mut s = NativeAudioStream::new(t.rtc_track(), 48000, 2);
                        let (mut peak, mut n) = (0u16, 0u32);
                        while let Some(f) = s.next().await {
                            peak = peak.max(f.data.iter().map(|x| x.unsigned_abs()).max().unwrap_or(0));
                            n += 1;
                            if n % 100 == 0 {
                                println!("{label}: peak {:.1}% over the last second", peak as f64 / i16::MAX as f64 * 100.0);
                                peak = 0;
                            }
                        }
                    });
                }
                Some(RoomEvent::TrackPublished { publication, participant }) => println!("published {} {}", participant.identity(), publication.name()),
                None => break,
                _ => {}
            }
        }
    }
    Ok(())
}

pub async fn find_app(id: &str) -> Result<audio::AudioApp> {
    let apps = tokio::task::spawn_blocking(audio::list_apps).await??;
    apps.into_iter()
        .find(|x| x.id == id || x.name.eq_ignore_ascii_case(id))
        .with_context(|| format!("no app playing audio matches {id:?}; see `friends-live apps`"))
}

fn wav(pcm: &[i16]) -> Vec<u8> {
    let data_len = (pcm.len() * 2) as u32;
    let rate = audio::SAMPLE_RATE;
    let ch = audio::CHANNELS as u16;
    let mut b = Vec::with_capacity(44 + data_len as usize);
    b.extend(b"RIFF");
    b.extend((36 + data_len).to_le_bytes());
    b.extend(b"WAVEfmt ");
    b.extend(16u32.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(ch.to_le_bytes());
    b.extend(rate.to_le_bytes());
    b.extend((rate * ch as u32 * 2).to_le_bytes());
    b.extend((ch * 2).to_le_bytes());
    b.extend(16u16.to_le_bytes());
    b.extend(b"data");
    b.extend(data_len.to_le_bytes());
    for s in pcm {
        b.extend(s.to_le_bytes());
    }
    b
}
