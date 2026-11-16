//! Windows that can be streamed on Windows, and finding the remembered one again.
//! A window is remembered by its program and title ("RuneLite.exe" + "RuneLite"), since window handles don't
//! survive a restart.

use anyhow::{anyhow, Result};
use serde::Serialize;
use windows_capture::window::Window;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct WinInfo {
    /// The window handle, as a string for the UI and menus.
    pub id: String,
    pub title: String,
    pub pid: u32,
    /// The program, e.g. "RuneLite.exe".
    pub exe: String,
}

impl WinInfo {
    pub fn hwnd(&self) -> isize {
        self.id.parse().unwrap_or(0)
    }

    /// How the choice is saved between runs.
    pub fn remember(&self) -> String {
        format!("{}\t{}", self.exe, self.title)
    }

    /// The program without ".exe", for "sound from …".
    pub fn app_name(&self) -> String {
        self.exe.strip_suffix(".exe").or_else(|| self.exe.strip_suffix(".EXE")).unwrap_or(&self.exe).to_string()
    }
}

fn info(w: &Window) -> Option<WinInfo> {
    let title = w.title().ok()?.trim().to_string();
    if title.is_empty() {
        return None;
    }
    let pid = w.process_id().ok()?;
    if pid == std::process::id() {
        return None; // never offer our own window
    }
    let exe = w.process_name().unwrap_or_default();
    Some(WinInfo { id: (w.as_raw_hwnd() as isize).to_string(), title, pid, exe })
}

/// Visible top-level windows with a title, in z-order (the frontmost first).
pub fn list() -> Vec<WinInfo> {
    Window::enumerate().map(|ws| ws.iter().filter_map(info).collect()).unwrap_or_default()
}

/// The window to stream: the one just picked, or else the remembered one (same program and title, or failing
/// that, the program's frontmost window).
pub fn find(pick: Option<isize>, remembered: Option<&str>) -> Result<WinInfo> {
    let all = list();
    if let Some(h) = pick {
        return all.into_iter().find(|w| w.hwnd() == h).ok_or_else(|| anyhow!("that window is gone; choose another"));
    }
    let (exe, title) = remembered.and_then(|r| r.split_once('\t')).ok_or_else(|| anyhow!("choose a window to stream"))?;
    all.iter()
        .find(|w| w.exe.eq_ignore_ascii_case(exe) && w.title == title)
        .or_else(|| all.iter().find(|w| w.exe.eq_ignore_ascii_case(exe)))
        .cloned()
        .ok_or_else(|| anyhow!("{} isn't open; choose a window to stream", exe.trim_end_matches(".exe")))
}
