//! One live stream: capture a window or screen, with the sound of the app that owns the window, and publish it
//! to the stage. Used by both the app window and the `stream` command.

use crate::audio;
use anyhow::{Context, Result};
use livekit::options::{DegradationPreference, TrackPublishOptions, VideoCodec, VideoEncoderBackend, VideoEncoding};
use livekit::prelude::*;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::prelude::AudioFrame;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, OnceLock};
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
    /// The last window choice, to reuse without asking (Wayland restore token).
    pub restore: Option<String>,
    pub fps: u32,
    pub height: u32,
    pub kbps: u64,
    pub hint: Hint,
    pub codec: VideoCodec,
    pub encoder: VideoEncoderBackend,
}

impl Options {
    pub fn from_quality(q: &Quality, restore: Option<String>) -> Self {
        Options {
            restore,
            fps: q.fps,
            height: q.height,
            kbps: q.kbps,
            hint: q.hint,
            codec: VideoCodec::VP8,
            encoder: VideoEncoderBackend::Auto,
        }
    }
}

#[cfg(target_os = "linux")]
type VideoCapture = crate::portal::Capture;
#[cfg(not(target_os = "linux"))]
type VideoCapture = crate::video::Capture;

pub struct Session {
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// The shared window's title (None for a whole screen).
    pub window: Option<String>,
    /// A window (not a whole screen) was shared.
    pub is_window: bool,
    /// Save this to reuse the same window next time.
    pub restore_token: Option<String>,
    sound_from: Arc<Mutex<Option<String>>>,
    room: Room,
    video: VideoCapture,
    sound: Option<tokio::task::JoinHandle<()>>,
    #[cfg(target_os = "linux")]
    _picked: crate::portal::Picked,
}

impl Session {
    /// Picks the window (silently when `restore` still works), joins the stage and publishes. The receiver
    /// reports `Disconnected` when the stream is ended from the site.
    pub async fn start(url: &str, token: &str, o: Options) -> Result<(Session, UnboundedReceiver<RoomEvent>)> {
        let video_slot = Arc::new(OnceLock::new());

        #[cfg(target_os = "linux")]
        let (picked, video, width, height) = {
            let picked = crate::portal::pick(o.restore.as_deref()).await?;
            let slot = video_slot.clone();
            let (fps, max_h) = (o.fps, o.height);
            tokio::task::spawn_blocking(move || {
                let mut picked = picked;
                crate::portal::start(&mut picked, fps, max_h, slot).map(|(c, w, h)| (picked, c, w, h))
            })
            .await??
        };
        #[cfg(target_os = "linux")]
        let (window, restore_token, is_window) = (picked.title.clone(), picked.restore_token.clone(), picked.is_window);

        #[cfg(not(target_os = "linux"))]
        let (video, width, height, window, restore_token, is_window) = {
            let slot = video_slot.clone();
            let (fps, max_h) = (o.fps, o.height);
            let s = tokio::task::spawn_blocking(move || crate::video::start(crate::video::default_kind(), None, fps, max_h, slot)).await??;
            (s.capture, s.width, s.height, None::<String>, None::<String>, false)
        };

        let video_src = NativeVideoSource::new(VideoResolution { width, height }, true);
        let _ = video_slot.set(video_src.clone());

        let mut opts = RoomOptions::default();
        opts.auto_subscribe = false;
        let (room, events) = Room::connect(url, token, opts).await.context("couldn't join the stage")?;

        // Same naming as the browser: viewers read the quality from the name and pair "<name>-audio" with it.
        let detail = format!("{}p · {} fps", height, o.fps);
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

        let sound_from = Arc::new(Mutex::new(None));
        let sound = window.clone().map(|title| {
            tokio::spawn(follow_sound(room.local_participant(), format!("{name}-audio"), title, sound_from.clone()))
        });

        Ok((
            Session {
                name,
                width,
                height,
                window,
                is_window,
                restore_token,
                sound_from,
                room,
                video,
                sound,
                #[cfg(target_os = "linux")]
                _picked: picked,
            },
            events,
        ))
    }

    /// The app whose sound is being streamed right now, if any.
    pub fn sound_from(&self) -> Option<String> {
        self.sound_from.lock().unwrap().clone()
    }

    /// The shared window was closed, or the OS ended the share.
    pub fn capture_ended(&self) -> bool {
        #[cfg(target_os = "linux")]
        return self.video.ended();
        #[cfg(not(target_os = "linux"))]
        return false;
    }

    pub async fn stop(self) {
        if let Some(t) = self.sound {
            t.abort();
            let _ = t.await;
        }
        drop(self.video);
        let _ = self.room.close().await;
    }
}

/// Streams the sound of the app that owns the shared window, matched by the window's title. Checks again every
/// few seconds, so the sound starts when the app starts playing and follows it as its streams come and go.
async fn follow_sound(me: LocalParticipant, track_name: String, title: String, sound_from: Arc<Mutex<Option<String>>>) {
    let mixer = Arc::new(audio::Mixer::default());
    let mut capture: Option<audio::Capture> = None;
    let mut targets: Vec<String> = Vec::new();
    let mut published = false;

    // Stop the pump when this task is aborted.
    struct Cleanup(Option<tokio::task::JoinHandle<()>>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            if let Some(p) = self.0.take() {
                p.abort();
            }
        }
    }
    let mut cleanup = Cleanup(None);

    loop {
        let apps = tokio::task::spawn_blocking(audio::list_apps).await.ok().and_then(|r| r.ok()).unwrap_or_default();
        let app = audio::app_for_title(&title, &apps);
        let now: Vec<String> = app.as_ref().map(|a| a.targets.clone()).unwrap_or_default();

        if now != targets {
            drop(capture.take());
            mixer.reset();
            if let Some(app) = &app {
                match audio::capture(app, mixer.clone()) {
                    Ok(c) => capture = Some(c),
                    Err(e) => log::warn!("couldn't capture {}'s sound: {e:#}", app.name),
                }
            }
            targets = now;
            *sound_from.lock().unwrap() = app.as_ref().filter(|_| capture.is_some()).map(|a| a.name.clone());

            // Publish the track the first time there's sound; keep it (silent) if the app goes quiet.
            if capture.is_some() && !published {
                let src = NativeAudioSource::new(AudioSourceOptions::default(), audio::SAMPLE_RATE, audio::CHANNELS, 100);
                let track = LocalAudioTrack::create_audio_track(&track_name, RtcAudioSource::Native(src.clone()));
                let opts = TrackPublishOptions { source: TrackSource::ScreenshareAudio, dtx: false, red: false, ..Default::default() };
                match me.publish_track(LocalTrack::Audio(track), opts).await {
                    Ok(_) => {
                        let m = mixer.clone();
                        let pump = tokio::spawn(async move {
                            let mut tick = tokio::time::interval(Duration::from_millis(10));
                            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
                            let (mut n, mut peak) = (0u32, 0u16);
                            loop {
                                tick.tick().await;
                                let data = m.next_frame();
                                peak = peak.max(data.iter().map(|x| x.unsigned_abs()).max().unwrap_or(0));
                                n += 1;
                                if n % 500 == 0 {
                                    log::debug!("sound: peak {:.1}% over 5 s, {}", peak as f64 / i16::MAX as f64 * 100.0, m.describe());
                                    peak = 0;
                                }
                                let frame = AudioFrame {
                                    data: data.into(),
                                    sample_rate: audio::SAMPLE_RATE,
                                    num_channels: audio::CHANNELS,
                                    samples_per_channel: audio::SAMPLE_RATE / 100,
                                };
                                if src.capture_frame(&frame).await.is_err() {
                                    break;
                                }
                            }
                        });
                        cleanup.0 = Some(pump);
                        published = true;
                    }
                    Err(e) => log::warn!("couldn't publish the sound: {e}"),
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
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
