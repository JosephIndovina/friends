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

/// The window the system chooser returned, which only says its title (and size): the matching open window.
pub fn by_title(title: &str, size: Option<(i32, i32)>) -> Option<WinInfo> {
    let all = list();
    let same: Vec<&WinInfo> = all.iter().filter(|w| w.title == title).collect();
    if same.len() > 1 {
        if let Some((sw, sh)) = size {
            // Several windows with one title: the one whose size matches.
            if let Some(w) = same.iter().find(|w| {
                let win = Window::from_raw_hwnd(w.hwnd() as *mut std::ffi::c_void);
                win.width().ok() == Some(sw) && win.height().ok() == Some(sh)
            }) {
                return Some((*w).clone());
            }
        }
    }
    same.first().map(|w| (*w).clone())
}

/// The remembered window: same program and title, or failing that, the program's frontmost window.
pub fn find(remembered: Option<&str>) -> Result<WinInfo> {
    let all = list();
    let (exe, title) = remembered.and_then(|r| r.split_once('\t')).ok_or_else(|| anyhow!("choose a window to stream"))?;
    all.iter()
        .find(|w| w.exe.eq_ignore_ascii_case(exe) && w.title == title)
        .or_else(|| all.iter().find(|w| w.exe.eq_ignore_ascii_case(exe)))
        .cloned()
        .ok_or_else(|| anyhow!("{} isn't open; choose a window to stream", exe.trim_end_matches(".exe")))
}
