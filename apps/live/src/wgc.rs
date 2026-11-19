//! Window capture on Windows through Windows Graphics Capture (what OBS and Discord use): works for games and
//! hardware-accelerated windows, follows the window as it moves and resizes. Frames go to WebRTC as I420.

use anyhow::{anyhow, Result};
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::prelude::*;
use livekit::webrtc::video_source::native::NativeVideoSource;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::time::{Duration, Instant};
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl};
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings,
    SecondaryWindowSettings, Settings,
};
use windows_capture::graphics_capture_picker::GraphicsCapturePicker;
use windows_capture::window::Window;

pub struct Flags {
    out: Arc<OnceLock<NativeVideoSource>>,
    first: mpsc::Sender<Result<(u32, u32), String>>,
    fps: u32,
    max_height: u32,
    ended: Arc<AtomicBool>,
}

pub struct Handler {
    out: Arc<OnceLock<NativeVideoSource>>,
    first: Option<mpsc::Sender<Result<(u32, u32), String>>>,
    min_gap: Duration,
    last: Option<Instant>,
    max_height: u32,
    ended: Arc<AtomicBool>,
}

impl GraphicsCaptureApiHandler for Handler {
    type Flags = Flags;
    type Error = anyhow::Error;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let f = ctx.flags;
        Ok(Handler {
            out: f.out,
            first: Some(f.first),
            min_gap: Duration::from_secs_f64(0.95 / f.fps.max(1) as f64),
            last: None,
            max_height: f.max_height,
            ended: f.ended,
        })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, _control: InternalCaptureControl) -> Result<(), Self::Error> {
        let now = Instant::now();
        if self.last.is_some_and(|t| now.duration_since(t) < self.min_gap) {
            return Ok(());
        }
        let mut fb = frame.buffer().map_err(|e| anyhow!("{e}"))?;
        let (w, h, pitch) = (fb.width() & !1, fb.height() & !1, fb.row_pitch());
        if w == 0 || h == 0 {
            return Ok(());
        }
        let px = fb.as_raw_buffer();
        let mut buf = I420Buffer::new(w, h);
        let (sy, su, sv) = buf.strides();
        let (y, u, v) = buf.data_mut();
        // BGRA in memory, which libyuv calls ARGB.
        yuv_helper::argb_to_i420(px, pitch, y, sy, u, su, v, sv, w as i32, h as i32);
        let buf = if h > self.max_height {
            let th = self.max_height & !1;
            let tw = ((w as u64 * th as u64 / h as u64) as u32) & !1;
            buf.scale(tw as i32, th as i32)
        } else {
            buf
        };
        self.last = Some(now);
        if let Some(tx) = self.first.take() {
            let _ = tx.send(Ok((buf.width(), buf.height())));
        }
        if let Some(src) = self.out.get() {
            src.capture_frame(&VideoFrame::new(VideoRotation::VideoRotation0, buf));
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        self.ended.store(true, Ordering::Relaxed);
        Ok(())
    }
}

/// The system's "choose a window" dialog. It says only the picked item's title, so the window is found by title
/// (that gives its process, for the sound). Must run on a thread that can block.
pub fn pick() -> Result<crate::winwin::WinInfo> {
    let picked = match GraphicsCapturePicker::pick_item() {
        Ok(Some(p)) => p,
        Ok(None) => return Err(anyhow!("capture cancelled")),
        Err(e) => return Err(anyhow!("capture cancelled ({e})")),
    };
    let title = picked.item.DisplayName().map(|t| t.to_string()).unwrap_or_default();
    let size = picked.size().ok();
    crate::winwin::by_title(&title, size)
        .ok_or_else(|| anyhow!("pick a window: streaming a whole screen isn't available on Windows yet"))
}

/// A running capture; dropping it stops it.
pub struct Capture {
    control: Option<CaptureControl<Handler, anyhow::Error>>,
    ended: Arc<AtomicBool>,
    hwnd: isize,
}

impl Capture {
    /// The window was closed, or hidden: many apps only hide their window when closed (to the tray).
    pub fn ended(&self) -> bool {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{IsWindow, IsWindowVisible};
        let hwnd = HWND(self.hwnd as *mut std::ffi::c_void);
        let gone = unsafe { !IsWindow(Some(hwnd)).as_bool() || !IsWindowVisible(hwnd).as_bool() };
        gone || self.ended.load(Ordering::Relaxed) || self.control.as_ref().is_some_and(|c| c.is_finished())
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        if let Some(c) = self.control.take() {
            let _ = c.stop();
        }
    }
}

/// Starts capturing window `hwnd` at up to `fps`, scaled to fit `max_height`. Returns once the first frame
/// arrives, with its size.
pub fn start(hwnd: isize, fps: u32, max_height: u32, out: Arc<OnceLock<NativeVideoSource>>) -> Result<(Capture, u32, u32)> {
    let window = Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void);
    if !window.is_valid() {
        return Err(anyhow!("that window can't be captured"));
    }
    let (first_tx, first_rx) = mpsc::channel();
    let ended = Arc::new(AtomicBool::new(false));
    // Windows 11 lets us drop the yellow capture border and cap the frame rate; Windows 10 can't.
    let border = if GraphicsCaptureApi::is_border_settings_supported().unwrap_or(false) {
        DrawBorderSettings::WithoutBorder
    } else {
        DrawBorderSettings::Default
    };
    let interval = if GraphicsCaptureApi::is_minimum_update_interval_supported().unwrap_or(false) {
        MinimumUpdateIntervalSettings::Custom(Duration::from_secs_f64(1.0 / fps.max(1) as f64))
    } else {
        MinimumUpdateIntervalSettings::Default
    };
    let settings = Settings::new(
        window,
        CursorCaptureSettings::WithCursor,
        border,
        SecondaryWindowSettings::Default,
        interval,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        Flags { out, first: first_tx, fps, max_height, ended: ended.clone() },
    );
    let control = Handler::start_free_threaded(settings).map_err(|e| anyhow!("couldn't start capturing the window: {e}"))?;
    let (w, h) = match first_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(size)) => size,
        Ok(Err(e)) => return Err(anyhow!(e)),
        Err(_) => {
            let _ = control.stop();
            return Err(anyhow!("the window didn't send a picture (is it minimised?)"));
        }
    };
    Ok((Capture { control: Some(control), ended, hwnd }, w, h))
}
