//! Capturing one app's audio, mixed down to 48 kHz stereo for publishing.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{capture, list_apps, Capture};

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
/// One 10 ms frame, interleaved stereo: what WebRTC wants per push.
pub const FRAME_SAMPLES: usize = (SAMPLE_RATE / 100 * CHANNELS) as usize;

#[derive(Debug, Clone, serde::Serialize)]
pub struct AudioApp {
    /// Stable for the life of the process (its pid), or "name:<app>" when the OS doesn't say.
    pub id: String,
    pub name: String,
    pub binary: Option<String>,
    /// OS handles for each of the app's playback streams.
    #[serde(skip)]
    pub targets: Vec<String>,
}

/// An app can play several streams at once (a browser's tabs). Each gets an input here; the publisher
/// pulls 10 ms at a time and gets their sum.
#[derive(Default)]
pub struct Mixer {
    inputs: Mutex<Vec<Arc<Mutex<VecDeque<f32>>>>>,
}

pub struct MixerInput(Arc<Mutex<VecDeque<f32>>>);

/// Cap per-input buffering at 200 ms so a stalled reader can't build up delay.
const MAX_BUFFER: usize = FRAME_SAMPLES * 20;

impl MixerInput {
    pub fn push(&self, samples: &[f32]) {
        let mut q = self.0.lock().unwrap();
        q.extend(samples.iter().copied());
        let excess = q.len().saturating_sub(MAX_BUFFER);
        q.drain(..excess);
    }
}

impl Mixer {
    pub fn add_input(&self) -> MixerInput {
        let q = Arc::new(Mutex::new(VecDeque::new()));
        self.inputs.lock().unwrap().push(q.clone());
        MixerInput(q)
    }

    /// The next 10 ms as 16-bit samples. Inputs that are behind contribute silence rather than holding the rest up.
    pub fn next_frame(&self) -> Vec<i16> {
        let mut mix = vec![0f32; FRAME_SAMPLES];
        for q in self.inputs.lock().unwrap().iter() {
            let mut q = q.lock().unwrap();
            if q.len() < FRAME_SAMPLES {
                continue;
            }
            for (m, s) in mix.iter_mut().zip(q.drain(..FRAME_SAMPLES)) {
                *m += s;
            }
        }
        mix.into_iter().map(|s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).collect()
    }
}
