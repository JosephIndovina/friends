//! App audio on Windows: WASAPI process loopback records exactly what one process (and its children, so a
//! browser's audio service is included) plays, at 48 kHz stereo float. Nothing else on the system is heard.

use super::{Mixer, CHANNELS, SAMPLE_RATE};
use anyhow::{anyhow, Result};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};

/// Handle to a running capture; dropping it stops the capture thread.
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

/// Records process `pid` (and its children) into `mixer`.
pub fn capture_process(pid: u32, mixer: Arc<Mixer>) -> Result<Capture> {
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::channel::<Result<()>>();
    let thread = std::thread::Builder::new().name("wasapi".into()).spawn({
        let stop = stop.clone();
        move || {
            let ready = ready_tx.clone();
            if let Err(e) = run(pid, &mixer, &stop, ready_tx) {
                log::warn!("app sound capture stopped: {e}");
                let _ = ready.send(Err(e));
            }
        }
    })?;
    ready_rx.recv().map_err(|_| anyhow!("sound capture thread died"))??;
    Ok(Capture { stop, thread: Some(thread) })
}

fn run(pid: u32, mixer: &Mixer, stop: &AtomicBool, ready: mpsc::Sender<Result<()>>) -> Result<()> {
    use wasapi::*;
    // COM on this thread; process loopback wants the multithreaded apartment.
    let _ = initialize_mta().ok();
    let format = WaveFormat::new(32, 32, SampleType::Float, SAMPLE_RATE as usize, CHANNELS as usize, None);
    let block = format.get_blockalign() as usize;
    let mut client = AudioClient::new_application_loopback_client(pid, true).map_err(|e| anyhow!("{e}"))?;
    client
        .initialize_client(&format, Direction::Capture, StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 }, None)
        .map_err(|e| anyhow!("{e}"))?;
    let event = client.set_get_eventhandle().map_err(|e| anyhow!("{e}"))?;
    let capture = client.get_audiocaptureclient().map_err(|e| anyhow!("{e}"))?;
    client.start_stream().map_err(|e| anyhow!("{e}"))?;
    let _ = ready.send(Ok(()));

    let input = mixer.add_input();
    let mut bytes: VecDeque<u8> = VecDeque::new();
    while !stop.load(Ordering::Relaxed) {
        // A silent app may send no events at all; that's not an error, just keep waiting.
        let _ = event.wait_for_event(100);
        loop {
            let frames = capture.get_next_packet_size().map_err(|e| anyhow!("{e}"))?.unwrap_or(0);
            if frames == 0 {
                break;
            }
            capture.read_from_device_to_deque(&mut bytes).map_err(|e| anyhow!("{e}"))?;
        }
        let whole = bytes.len() / block * block;
        if whole > 0 {
            let chunk: Vec<u8> = bytes.drain(..whole).collect();
            let samples: Vec<f32> = chunk.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
            input.push(&samples);
        }
    }
    let _ = client.stop_stream();
    Ok(())
}
