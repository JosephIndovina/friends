//! Capturing one app's audio, mixed down to 48 kHz stereo for publishing.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{capture, init as pipewire_init, list_apps, Capture};

/// The app whose sound belongs with a window, judged by its title ("RuneLite", "Video — Mozilla Firefox").
/// The longest app name found as a whole word in the title wins.
pub fn app_for_title(title: &str, apps: &[AudioApp]) -> Option<AudioApp> {
    let words = |s: &str| -> Vec<String> {
        s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_string).collect()
    };
    let t = words(title);
    let contains = |needle: &[String]| !needle.is_empty() && t.windows(needle.len()).any(|w| w == needle);
    apps.iter()
        .filter_map(|a| {
            let by_name = words(&a.name);
            let by_binary = a.binary.as_deref().map(words).unwrap_or_default();
            // A bare interpreter (java, python) says nothing about which window it is.
            let generic = matches!(by_binary.as_slice(), [b] if ["java", "python", "python3", "wine", "wine64", "node"].contains(&b.as_str()));
            let hit = if contains(&by_name) { by_name.len() } else if !generic && contains(&by_binary) { by_binary.len() } else { 0 };
            (hit > 0).then(|| (hit, a.name.len(), a))
        })
        .max_by_key(|(hit, len, _)| (*hit, *len))
        .map(|(_, _, a)| a.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn app(name: &str, binary: Option<&str>) -> AudioApp {
        AudioApp { id: name.into(), name: name.into(), binary: binary.map(Into::into), targets: vec![] }
    }

    #[test]
    fn matches_by_title() {
        let apps = vec![app("Firefox", Some("firefox")), app("RuneLite", Some("java")), app("Spotify", None)];
        assert_eq!(app_for_title("RuneLite", &apps).unwrap().name, "RuneLite");
        assert_eq!(app_for_title("Some video - YouTube — Mozilla Firefox", &apps).unwrap().name, "Firefox");
        assert_eq!(app_for_title("Spotify Premium", &apps).unwrap().name, "Spotify");
        assert!(app_for_title("Terminal", &apps).is_none());
        // "java" alone must not match a title that merely mentions it.
        assert!(app_for_title("Learning java", &[app("Some Game", Some("java"))]).is_none());
    }
}

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

    /// Drop every input (before capturing a new set of streams).
    pub fn reset(&self) {
        self.inputs.lock().unwrap().clear();
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
