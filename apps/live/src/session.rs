//! One live stream: capture a screen or window (and optionally one app's sound) and publish it to the stage.
//! Used by both the app window and the `stream` command.

use crate::{audio, video};
use anyhow::{Context, Result};
use livekit::options::{DegradationPreference, TrackPublishOptions, VideoCodec, VideoEncoderBackend, VideoEncoding};
use livekit::prelude::*;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::prelude::AudioFrame;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedReceiver;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Hint {
    /// Keep the frame rate up when bandwidth drops.
    Motion,
    /// Keep the picture sharp (text, code).
    Detail,
}

/// Same presets as the site's browser streaming.
#[derive(Debug, Clone, Serialize)]
pub struct Quality {
    pub id: &'static str,
    pub label: &'static str,
    pub detail: &'static str,
    pub height: u32,
    pub fps: u32,
    pub kbps: u64,
    pub hint: Hint,
}

pub const QUALITIES: &[Quality] = &[
    Quality { id: "game-smooth", label: "Game: smooth", detail: "1080p · 60 fps · 6 Mbps", height: 1080, fps: 60, kbps: 6000, hint: Hint::Motion },
    Quality { id: "game-light", label: "Game: light", detail: "720p · 60 fps · 3.5 Mbps", height: 720, fps: 60, kbps: 3500, hint: Hint::Motion },
    Quality { id: "balanced", label: "Balanced", detail: "1080p · 30 fps · 3 Mbps", height: 1080, fps: 30, kbps: 3000, hint: Hint::Motion },
    Quality { id: "sharp", label: "Sharp", detail: "1440p · 60 fps · 10 Mbps", height: 1440, fps: 60, kbps: 10000, hint: Hint::Motion },
    Quality { id: "text", label: "Text and code", detail: "1080p · 15 fps · 1.5 Mbps", height: 1080, fps: 15, kbps: 1500, hint: Hint::Detail },
    Quality { id: "low", label: "Low bandwidth", detail: "720p · 30 fps · 1.2 Mbps", height: 720, fps: 30, kbps: 1200, hint: Hint::Motion },
];

pub fn quality(id: &str) -> &'static Quality {
    QUALITIES.iter().find(|q| q.id == id).unwrap_or(&QUALITIES[0])
}

pub struct Options {
    pub kind: video::Kind,
    pub source: Option<u64>,
    pub fps: u32,
    pub height: u32,
    pub kbps: u64,
    pub hint: Hint,
    pub codec: VideoCodec,
    pub encoder: VideoEncoderBackend,
    pub app: Option<audio::AudioApp>,
}

impl Options {
    pub fn from_quality(q: &Quality, app: Option<audio::AudioApp>) -> Self {
        Options {
            kind: video::default_kind(),
            source: None,
            fps: q.fps,
            height: q.height,
            kbps: q.kbps,
            hint: q.hint,
            codec: VideoCodec::VP8,
            encoder: VideoEncoderBackend::Auto,
            app,
        }
    }
}

pub struct Session {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub sound_from: Option<String>,
    room: Room,
    video: video::Capture,
    audio: Option<(audio::Capture, tokio::task::JoinHandle<()>)>,
}

impl Session {
    /// Opens the picker where the OS has one, joins the stage and publishes. The receiver reports
    /// `Disconnected` when the stream is ended from the site.
    pub async fn start(url: &str, token: &str, o: Options) -> Result<(Session, UnboundedReceiver<RoomEvent>)> {
        let video_slot = Arc::new(std::sync::OnceLock::new());
        let started = {
            let slot = video_slot.clone();
            let (kind, source, fps, height) = (o.kind, o.source, o.fps, o.height);
            tokio::task::spawn_blocking(move || video::start(kind, source, fps, height, slot)).await??
        };
        let video_src = NativeVideoSource::new(VideoResolution { width: started.width, height: started.height }, true);
        let _ = video_slot.set(video_src.clone());

        let mut opts = RoomOptions::default();
        opts.auto_subscribe = false;
        let (room, events) = Room::connect(url, token, opts).await.context("couldn't join the stage")?;

        // Same naming as the browser: viewers read the quality from the name and pair "<name>-audio" with it.
        let detail = format!("{}p · {} fps", started.height, o.fps);
        let name = format!("screen-{}-0~{}", base36(now_ms()), detail.replace(' ', "_"));

        let track = LocalVideoTrack::create_video_track(&name, RtcVideoSource::Native(video_src));
        room.local_participant()
            .publish_track(
                LocalTrack::Video(track),
                TrackPublishOptions {
                    source: TrackSource::Screenshare,
                    simulcast: false,
                    video_codec: o.codec,
                    video_encoder: o.encoder,
                    video_encoding: Some(VideoEncoding { max_bitrate: o.kbps * 1000, max_framerate: o.fps as f64 }),
                    degradation_preference: Some(match o.hint {
                        Hint::Motion => DegradationPreference::MaintainFramerate,
                        Hint::Detail => DegradationPreference::MaintainResolution,
                    }),
                    ..Default::default()
                },
            )
            .await
            .context("couldn't publish the picture")?;

        let mut audio_parts = None;
        if let Some(app) = &o.app {
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
                    let frame = AudioFrame {
                        data: mixer.next_frame().into(),
                        sample_rate: audio::SAMPLE_RATE,
                        num_channels: audio::CHANNELS,
                        samples_per_channel: audio::SAMPLE_RATE / 100,
                    };
                    if let Err(e) = src.capture_frame(&frame).await {
                        log::warn!("audio push failed: {e}");
                    }
                }
            });
            audio_parts = Some((cap, pump));
        }

        Ok((
            Session {
                name,
                width: started.width,
                height: started.height,
                sound_from: o.app.map(|a| a.name),
                room,
                video: started.capture,
                audio: audio_parts,
            },
            events,
        ))
    }

    pub async fn stop(self) {
        if let Some((cap, pump)) = self.audio {
            pump.abort();
            drop(cap);
        }
        drop(self.video);
        let _ = self.room.close().await;
    }
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
