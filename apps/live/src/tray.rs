//! The tray icon: where the app lives. Everything the window can do is in its menu.

use crate::gui::{self, Shared};
use crate::session::QUALITIES;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

pub const ID: &str = "main";

const ICON: &[u8] = include_bytes!("../icons/tray.png");
const ICON_LIVE: &[u8] = include_bytes!("../icons/tray-live.png");

/// What the menu shows; built from the app state.
#[derive(Clone, PartialEq)]
pub struct TrayState {
    pub status: String,
    pub error: Option<String>,
    pub live: bool,
    pub starting: bool,
    pub connected: bool,
    pub has_window: bool,
    pub quality: String,
    pub codec: String,
    pub encoder: String,
    pub auto_start: bool,
}

/// What the tray shows now. Rebuilding a menu makes the desktop redraw the tray, so it's only done on a change.
static SHOWN: std::sync::Mutex<Option<TrayState>> = std::sync::Mutex::new(None);

fn icon(live: bool) -> Option<Image<'static>> {
    Image::from_bytes(if live { ICON_LIVE } else { ICON }).ok()
}

fn menu(app: &AppHandle, t: &TrayState) -> tauri::Result<Menu<Wry>> {
    let status = MenuItem::with_id(app, "status", &t.status, false, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status])?;
    if let Some(e) = &t.error {
        // Menus show one line; keep it short and leave the full text to the window.
        let short: String = if e.chars().count() > 70 { e.chars().take(68).chain("…".chars()).collect() } else { e.clone() };
        menu.append(&MenuItem::with_id(app, "error", short, false, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let primary = if t.live {
        MenuItem::with_id(app, "stop", "Stop streaming", true, None::<&str>)?
    } else {
        MenuItem::with_id(app, "golive", if t.starting { "Starting…" } else { "Go live" }, t.connected && !t.starting, None::<&str>)?
    };
    menu.append(&primary)?;
    menu.append(&MenuItem::with_id(app, "change", "Change window", !t.starting && (t.live || t.has_window), None::<&str>)?)?;

    // Quality applies from the next Go live, so it's locked while live.
    let quality = Submenu::with_id(app, "quality", "Quality", true)?;
    for q in QUALITIES {
        let label = format!("{} · {}", q.label, q.detail);
        quality.append(&CheckMenuItem::with_id(app, format!("q:{}", q.id), label, !t.live && !t.starting, t.quality == q.id, None::<&str>)?)?;
    }
    menu.append(&quality)?;

    // Viewers' browsers decode whatever is sent; the labels say who can't.
    let codec = Submenu::with_id(app, "codec", "Video codec", true)?;
    for (id, label) in CODECS {
        codec.append(&CheckMenuItem::with_id(app, format!("c:{id}"), *label, !t.live && !t.starting, t.codec == *id, None::<&str>)?)?;
    }
    menu.append(&codec)?;
    let encoder = Submenu::with_id(app, "encoder", "Encoder", true)?;
    for (id, label) in ENCODERS {
        encoder.append(&CheckMenuItem::with_id(app, format!("e:{id}"), *label, !t.live && !t.starting, t.encoder == *id, None::<&str>)?)?;
    }
    menu.append(&encoder)?;
    menu.append(&CheckMenuItem::with_id(app, "auto", "Go live when the site opens this app", true, t.auto_start, None::<&str>)?)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "show", "Open window", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "site", "Open the site", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
    Ok(menu)
}

pub const CODECS: &[(&str, &str)] = &[
    ("vp8", "VP8 · plays everywhere"),
    ("h264", "H.264 · plays everywhere, best for graphics cards"),
    ("vp9", "VP9 · sharper at the same bitrate"),
    ("av1", "AV1 · sharpest, but heavy, and not every browser plays it"),
];

pub const ENCODERS: &[(&str, &str)] = &[
    ("auto", "Automatic"),
    ("hardware", "Graphics card"),
    ("software", "Processor"),
];

pub fn create(app: &AppHandle, t: &TrayState) -> tauri::Result<()> {
    let mut b = TrayIconBuilder::with_id(ID).menu(&menu(app, t)?).tooltip(&t.status).on_menu_event(on_menu);
    if let Some(i) = icon(t.live) {
        b = b.icon(i);
    }
    b.build(app)?;
    *SHOWN.lock().unwrap() = Some(t.clone());
    Ok(())
}

pub fn update(app: &AppHandle, t: &TrayState) {
    let Some(tray) = app.tray_by_id(ID) else { return };
    let mut shown = SHOWN.lock().unwrap();
    if shown.as_ref() == Some(t) {
        return;
    }
    match menu(app, t) {
        Ok(m) => {
            let _ = tray.set_menu(Some(m));
        }
        Err(e) => log::warn!("couldn't rebuild the tray menu: {e}"),
    }
    if shown.as_ref().is_none_or(|s| s.live != t.live) {
        let _ = tray.set_icon(icon(t.live));
    }
    if shown.as_ref().is_none_or(|s| s.status != t.status) {
        let _ = tray.set_tooltip(Some(&t.status));
    }
    *shown = Some(t.clone());
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    let shared: Shared = app.state::<Shared>().inner().clone();
    let app = app.clone();
    let id = event.id().as_ref().to_string();
    match id.as_str() {
        "show" => gui::focus(&app),
        "quit" => app.exit(0),
        _ => {
            tauri::async_runtime::spawn(async move {
                match id.as_str() {
                    "golive" => gui::start_live(app, shared).await,
                    "stop" => gui::stop_now(app, shared).await,
                    "change" => gui::change_window_now(app, shared).await,
                    "site" => gui::open_site_now(shared).await,
                    "auto" => {
                        let on = !shared.lock().await.settings_auto_start();
                        gui::set_settings(app, shared, None, Some(on)).await;
                    }
                    q if q.starts_with("q:") => gui::set_settings(app, shared, Some(q[2..].to_string()), None).await,
                    c if c.starts_with("c:") => gui::set_video(app, shared, Some(c[2..].to_string()), None).await,
                    e if e.starts_with("e:") => gui::set_video(app, shared, None, Some(e[2..].to_string())).await,
                    _ => {}
                }
            });
        }
    }
}
