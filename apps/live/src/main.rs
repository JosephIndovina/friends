//! Friends Live: streams a screen or window plus one app's audio to the stage.
//! This is the command-line spike; the desktop app wraps the same pieces.

mod audio;
mod video;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use livekit::options::{DegradationPreference, TrackPublishOptions, VideoCodec, VideoEncoderBackend, VideoEncoding};
use livekit::prelude::*;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::prelude::AudioFrame;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
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
    /// Screens or windows that can be shared (not available on Wayland; the OS picker is used there).
    Sources {
        #[arg(long, value_enum, default_value_t = KindArg::Window)]
        kind: KindArg,
    },
    /// Go live.
    Stream(StreamArgs),
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
    /// Audio from this app (an id from `apps`). Leave out for no sound.
    #[arg(long)]
    app: Option<String>,
    #[arg(long, value_enum, default_value_t = default_kind())]
    kind: KindArg,
    /// A source id from `sources`; leave out to use the OS picker where there is one.
    #[arg(long)]
    source: Option<u64>,
    #[arg(long, default_value_t = 60)]
    fps: u32,
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

fn default_kind() -> KindArg {
    #[cfg(target_os = "linux")]
    if video::needs_os_picker() {
        return KindArg::Picker;
    }
    KindArg::Screen
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

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info,libwebrtc=warn")).init();
    match Cli::parse().cmd {
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
        Cmd::Stream(args) => stream(args).await?,
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

async fn find_app(id: &str) -> Result<audio::AudioApp> {
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

async fn stream(a: StreamArgs) -> Result<()> {
    // Pick the app first so a typo fails before the screen picker opens.
    let app = match &a.app {
        None => None,
        Some(id) => Some(find_app(id).await?),
    };

    let video_slot = Arc::new(std::sync::OnceLock::new());
    let started = {
        let slot = video_slot.clone();
        let (kind, source, fps, height) = (a.kind.into(), a.source, a.fps, a.height);
        tokio::task::spawn_blocking(move || video::start(kind, source, fps, height, slot)).await??
    };
    let video_src = NativeVideoSource::new(VideoResolution { width: started.width, height: started.height }, true);
    let _ = video_slot.set(video_src.clone());
    log::info!("capturing {}x{}", started.width, started.height);

    let mut opts = RoomOptions::default();
    opts.auto_subscribe = false;
    let (room, mut events) = Room::connect(&a.url, &a.token, opts)
        .await
        .context("couldn't join the stage")?;
    log::info!("joined as {}", room.local_participant().identity());

    // Same naming as the browser: viewers read the quality from the name, and pair "<name>-audio" with it.
    let detail = format!("{}p · {} fps", started.height, a.fps);
    let name = format!("screen-{}-0~{}", base36(now_ms()), detail.replace(' ', "_"));

    let video_track = LocalVideoTrack::create_video_track(&name, RtcVideoSource::Native(video_src));
    room.local_participant()
        .publish_track(
            LocalTrack::Video(video_track),
            TrackPublishOptions {
                source: TrackSource::Screenshare,
                simulcast: false,
                video_codec: match a.codec {
                    CodecArg::Vp8 => VideoCodec::VP8,
                    CodecArg::H264 => VideoCodec::H264,
                },
                video_encoder: match a.encoder {
                    EncoderArg::Auto => VideoEncoderBackend::Auto,
                    EncoderArg::Software => VideoEncoderBackend::Software,
                    EncoderArg::Hardware => VideoEncoderBackend::Hardware,
                    EncoderArg::Nvenc => VideoEncoderBackend::Nvenc,
                    EncoderArg::Vaapi => VideoEncoderBackend::Vaapi,
                },
                video_encoding: Some(VideoEncoding { max_bitrate: a.kbps * 1000, max_framerate: a.fps as f64 }),
                degradation_preference: Some(match a.hint {
                    HintArg::Motion => DegradationPreference::MaintainFramerate,
                    HintArg::Detail => DegradationPreference::MaintainResolution,
                }),
                ..Default::default()
            },
        )
        .await
        .context("couldn't publish the picture")?;

    // Audio: one app, mixed to 48 kHz stereo, pushed every 10 ms.
    let mut audio_parts = None;
    if let Some(app) = &app {
        let mixer = Arc::new(audio::Mixer::default());
        let cap = audio::capture(app, mixer.clone())?;
        let src = NativeAudioSource::new(AudioSourceOptions::default(), audio::SAMPLE_RATE, audio::CHANNELS, 100);
        let track = LocalAudioTrack::create_audio_track(&format!("{name}-audio"), RtcAudioSource::Native(src.clone()));
        room.local_participant()
            .publish_track(
                LocalTrack::Audio(track),
                TrackPublishOptions { source: TrackSource::ScreenshareAudio, dtx: false, red: false, ..Default::default() },
            )
            .await
            .context("couldn't publish the sound")?;
        let pump = tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(10));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
            loop {
                tick.tick().await;
                let data = mixer.next_frame();
                let frame = AudioFrame {
                    data: data.into(),
                    sample_rate: audio::SAMPLE_RATE,
                    num_channels: audio::CHANNELS,
                    samples_per_channel: audio::SAMPLE_RATE / 100,
                };
                if let Err(e) = src.capture_frame(&frame).await {
                    log::warn!("audio push failed: {e}");
                }
            }
        });
        log::info!("sound from {}", app.name);
        audio_parts = Some((cap, pump));
    }

    println!("live: {name}  (Ctrl-C to stop)");
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                log::info!("stopping");
                break;
            }
            ev = events.recv() => match ev {
                // The site's X (or a moderator) removes us from the room.
                Some(RoomEvent::Disconnected { reason }) => {
                    log::info!("stream ended: {reason:?}");
                    break;
                }
                None => break,
                _ => {}
            },
        }
    }

    if let Some((cap, pump)) = audio_parts {
        pump.abort();
        drop(cap);
    }
    drop(started.capture);
    let _ = room.close().await;
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn base36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut s = Vec::new();
    loop {
        s.push(D[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    s.reverse();
    String::from_utf8(s).unwrap()
}
