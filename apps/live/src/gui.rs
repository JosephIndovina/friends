//! The app window. The site opens friends://live?code=…&server=…; the app trades the code for a stage token
//! and goes live with the saved sound and quality. Everything about the stream is controlled from here.

use crate::session::{self, Quality, Session, QUALITIES};
use livekit::prelude::RoomEvent;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tokio::sync::Mutex;

/// The only site this build trusts, plus localhost for development. A link naming any other server is ignored,
/// so a stranger's page can't point the app at their own server.
const DEFAULT_SERVER: &str = "https://friends.indovina.dev";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    quality: String,
    /// Go live as soon as the site opens the app.
    auto_start: bool,
    /// The last shared window, reused without asking (Wayland restore token) until "Change window".
    restore_token: Option<String>,
    /// Its title, to show which window that is.
    window: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { quality: QUALITIES[0].id.into(), auto_start: true, restore_token: None, window: None }
    }
}

fn settings_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("friends-live").join("settings.json"))
}

fn load_settings() -> Settings {
    settings_path()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_settings_file(s: &Settings) {
    let Some(p) = settings_path() else { return };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(b) = serde_json::to_vec_pretty(s) {
        let _ = std::fs::write(p, b);
    }
}

/// What the site handed over: where the stage is and a token to publish on it.
struct Link {
    server: String,
    livekit: String,
    token: String,
    name: String,
}

#[derive(Default)]
pub(crate) struct Inner {
    link: Option<Link>,
    live: Option<Session>,
    starting: bool,
    error: Option<String>,
    settings: Settings,
}

pub(crate) type Shared = Arc<Mutex<Inner>>;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct View {
    name: Option<String>,
    /// Shown only when it isn't the usual site.
    server: Option<String>,
    starting: bool,
    live: Option<LiveView>,
    error: Option<String>,
    settings: Settings,
    qualities: &'static [Quality],
    picker: bool,
}

#[derive(Serialize, Clone)]
struct LiveView {
    detail: String,
    window: Option<String>,
    sound: Option<String>,
}

impl Inner {
    pub(crate) fn settings_auto_start(&self) -> bool {
        self.settings.auto_start
    }
}

fn view(i: &Inner) -> View {
    View {
        name: i.link.as_ref().map(|l| l.name.clone()),
        server: i.link.as_ref().map(|l| l.server.clone()).filter(|s| s != DEFAULT_SERVER),
        starting: i.starting,
        live: i.live.as_ref().map(|s| LiveView { detail: format!("{}×{}", s.width, s.height), window: s.window.clone(), sound: s.sound_from() }),
        error: i.error.clone(),
        settings: i.settings.clone(),
        qualities: QUALITIES,
        picker: crate::video::needs_os_picker(),
    }
}

/// Push the current state to the window and the tray.
async fn emit(app: &AppHandle, shared: &Shared) {
    let i = shared.lock().await;
    let _ = app.emit("state", view(&i));
    crate::tray::update(app, &tray_state(&i));
}

fn tray_state(i: &Inner) -> crate::tray::TrayState {
    let status = if let Some(s) = &i.live {
        let what = s.window.clone().unwrap_or_else(|| "whole screen".into());
        let sound = match (s.sound_from(), &s.window) {
            (Some(app), _) => format!("sound from {app}"),
            (None, Some(_)) => "no sound yet".into(),
            (None, None) => "no sound".into(),
        };
        format!("Live: {what} · {sound}")
    } else if i.starting {
        "Starting…".into()
    } else if i.link.is_some() {
        "Ready, not streaming".into()
    } else {
        "Not connected: press Go live on the site".into()
    };
    crate::tray::TrayState {
        status,
        error: i.error.clone(),
        live: i.live.is_some(),
        starting: i.starting,
        connected: i.link.is_some(),
        has_window: i.settings.restore_token.is_some(),
        quality: i.settings.quality.clone(),
        auto_start: i.settings.auto_start,
    }
}

#[tauri::command]
async fn get_state(shared: State<'_, Shared>) -> Result<View, ()> {
    Ok(view(&*shared.lock().await))
}

/// The window only changes quality and auto-start; the window choice is kept by the app itself.
#[tauri::command]
async fn save_settings(app: AppHandle, shared: State<'_, Shared>, quality: String, auto_start: bool) -> Result<(), ()> {
    set_settings(app, shared.inner().clone(), Some(quality), Some(auto_start)).await;
    Ok(())
}

pub(crate) async fn set_settings(app: AppHandle, shared: Shared, quality: Option<String>, auto_start: Option<bool>) {
    {
        let mut i = shared.lock().await;
        if let Some(q) = quality {
            i.settings.quality = q;
        }
        if let Some(a) = auto_start {
            i.settings.auto_start = a;
        }
        save_settings_file(&i.settings);
    }
    emit(&app, &shared).await;
}

#[tauri::command]
async fn change_window(app: AppHandle, shared: State<'_, Shared>) -> Result<(), ()> {
    change_window_now(app, shared.inner().clone()).await;
    Ok(())
}

/// Forget the remembered window and ask again; restarts the stream if it's live.
pub(crate) async fn change_window_now(app: AppHandle, shared: Shared) {
    let live = {
        let mut i = shared.lock().await;
        i.settings.restore_token = None;
        i.settings.window = None;
        save_settings_file(&i.settings);
        i.live.take()
    };
    let was_live = live.is_some();
    if let Some(s) = live {
        s.stop().await;
    }
    emit(&app, &shared).await;
    if was_live {
        start_live(app, shared).await;
    }
}

#[tauri::command]
async fn go_live(app: AppHandle, shared: State<'_, Shared>) -> Result<(), ()> {
    start_live(app, shared.inner().clone()).await;
    Ok(())
}

#[tauri::command]
async fn stop(app: AppHandle, shared: State<'_, Shared>) -> Result<(), ()> {
    stop_now(app, shared.inner().clone()).await;
    Ok(())
}

pub(crate) async fn stop_now(app: AppHandle, shared: Shared) {
    let s = shared.lock().await.live.take();
    if let Some(s) = s {
        s.stop().await;
    }
    emit(&app, &shared).await;
}

#[tauri::command]
async fn open_site(shared: State<'_, Shared>) -> Result<(), ()> {
    open_site_now(shared.inner().clone()).await;
    Ok(())
}

pub(crate) async fn open_site_now(shared: Shared) {
    let url = shared.lock().await.link.as_ref().map(|l| l.server.clone()).unwrap_or_else(|| DEFAULT_SERVER.into());
    open_url(&url);
}

fn open_url(url: &str) {
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(url).spawn();
    #[cfg(not(target_os = "windows"))]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
}

pub(crate) async fn start_live(app: AppHandle, shared: Shared) {
    let (url, token, settings) = {
        let mut i = shared.lock().await;
        if i.live.is_some() || i.starting {
            return;
        }
        let Some(link) = &i.link else {
            i.error = Some("Press Go live on the site to connect.".into());
            drop(i);
            emit(&app, &shared).await;
            return;
        };
        let out = (link.livekit.clone(), link.token.clone(), i.settings.clone());
        i.starting = true;
        i.error = None;
        out
    };
    emit(&app, &shared).await;

    let opts = session::Options::from_quality(session::quality(&settings.quality), settings.restore_token.clone());
    let result = Session::start(&url, &token, opts).await;

    let mut i = shared.lock().await;
    i.starting = false;
    match result {
        Ok((s, mut events)) => {
            // Remember the window so the next Go live doesn't ask.
            i.settings.restore_token = s.restore_token.clone();
            i.settings.window = s.window.clone();
            save_settings_file(&i.settings);
            i.error = match (s.is_window, &s.window) {
                (_, Some(_)) => None,
                // GNOME only tells us which window was shared when its choice is remembered.
                (true, None) => Some("Streaming without sound. To include the window's sound, leave \"Remember this selection\" on when you choose the window. Change window to choose again.".into()),
                (false, None) => Some("A whole screen is shared without sound. Share a window to include its sound.".into()),
            };
            i.live = Some(s);
            drop(i);
            // Ended from the site (the X), by a moderator, the connection dropping for good, or the window closing.
            // Also refreshes the window every few seconds so "sound from …" stays current.
            let (app2, shared2) = (app.clone(), shared.clone());
            tauri::async_runtime::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(2));
                loop {
                    tokio::select! {
                        ev = events.recv() => match ev {
                            Some(RoomEvent::Disconnected { .. }) | None => break,
                            _ => {}
                        },
                        _ = tick.tick() => {
                            let ended = shared2.lock().await.live.as_ref().is_none_or(|s| s.capture_ended());
                            if ended {
                                break;
                            }
                            emit(&app2, &shared2).await;
                        }
                    }
                }
                let s = shared2.lock().await.live.take();
                if let Some(s) = s {
                    s.stop().await;
                }
                emit(&app2, &shared2).await;
            });
        }
        Err(e) => {
            let msg = format!("{e:#}");
            log::warn!("go live failed: {msg}");
            i.error = Some(if msg.contains("cancelled") {
                "Nothing was picked to share.".into()
            } else if msg.contains("join") {
                // Usually an expired token: the site hands out a fresh one each time.
                i.link = None;
                "Couldn't reach the stage. Press Go live on the site again.".into()
            } else {
                msg
            });
            drop(i);
        }
    }
    emit(&app, &shared).await;
}

fn allowed(server: &url::Url) -> bool {
    let origin = server.origin().ascii_serialization();
    if origin == DEFAULT_SERVER {
        return true;
    }
    if matches!(server.host_str(), Some("localhost" | "127.0.0.1")) {
        return true;
    }
    std::env::var("FRIENDS_LIVE_SERVERS").is_ok_and(|v| v.split(',').any(|s| s.trim().trim_end_matches('/') == origin))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Redeemed {
    token: String,
    name: String,
    livekit_path: String,
}

/// friends://live?code=…&server=…
async fn handle_link(app: AppHandle, shared: Shared, link: url::Url) {
    if link.scheme() != "friends" || link.host_str() != Some("live") {
        return;
    }
    let q: std::collections::HashMap<_, _> = link.query_pairs().into_owned().collect();
    let (Some(code), Some(server)) = (q.get("code"), q.get("server").and_then(|s| url::Url::parse(s).ok())) else {
        return;
    };
    if !allowed(&server) {
        log::warn!("ignoring a link for {server}");
        return;
    }
    let base = server.origin().ascii_serialization();

    let res = async {
        let r = reqwest::Client::new()
            .post(format!("{base}/api/cast/launch/redeem"))
            .json(&serde_json::json!({ "code": code, "version": env!("CARGO_PKG_VERSION") }))
            .send()
            .await?;
        anyhow::Ok((r.status(), r.text().await?))
    }
    .await;

    let mut i = shared.lock().await;
    match res {
        Ok((status, body)) if status.is_success() => match serde_json::from_str::<Redeemed>(&body) {
            Ok(r) => {
                let ws = base.replacen("http", "ws", 1);
                i.link = Some(Link { server: base, livekit: format!("{ws}{}", r.livekit_path), token: r.token, name: r.name });
                i.error = None;
            }
            Err(_) => i.error = Some("The site sent something unexpected.".into()),
        },
        Ok((status, _)) if status.as_u16() == 426 => {
            i.error = Some("This version of Friends Live is too old. Download the new one from the site.".into())
        }
        Ok((status, _)) if status.as_u16() == 404 => {
            i.error = Some("That link expired. Press Go live on the site again.".into())
        }
        Ok((status, _)) if status.as_u16() == 403 => i.error = Some("Your account can't stream right now.".into()),
        Ok((status, _)) => i.error = Some(format!("The site said no ({status}).")),
        Err(_) => i.error = Some("Couldn't reach the site.".into()),
    }
    let go = i.link.is_some() && i.error.is_none() && i.settings.auto_start && i.live.is_none();
    drop(i);
    emit(&app, &shared).await;
    if go {
        start_live(app, shared).await;
    }
}

pub(crate) fn focus(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn run() {
    let shared: Shared = Arc::new(Mutex::new(Inner { settings: load_settings(), ..Default::default() }));
    tauri::Builder::default()
        // A second launch (another Go live click) hands its link to the running app instead.
        // Opened again from the app grid (no link): show the window. With a link, the deep-link plugin handles it.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if !argv.iter().any(|a| a.starts_with("friends://")) {
                focus(app);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .manage(shared.clone())
        .invoke_handler(tauri::generate_handler![get_state, save_settings, change_window, go_live, stop, open_site])
        .setup(move |app| {
            // Installed builds register friends:// at install time (the .deb's desktop entry, the Windows
            // installer). A bare binary run from elsewhere registers itself, but never on top of an installed copy:
            // its per-user entry would outrank the package's.
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                let installed = std::env::current_exe().is_ok_and(|p| p.starts_with("/usr/"));
                if !installed {
                    if let Err(e) = app.deep_link().register_all() {
                        log::warn!("couldn't register friends:// links: {e}");
                    }
                }
            }
            let handle = app.handle().clone();
            let s = shared.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    tauri::async_runtime::spawn(handle_link(handle.clone(), s.clone(), url));
                }
            });
            // A terminal kill or logout: exit through the normal path so the stream ends cleanly.
            #[cfg(unix)]
            {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tokio::signal::unix::{signal, SignalKind};
                    let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else { return };
                    tokio::select! { _ = term.recv() => {}, _ = int.recv() => {} }
                    h.exit(0);
                });
            }
            // Lives in the tray; the window opens from there (or when the tray isn't available).
            let has_tray = crate::tray::create(app.handle(), &tray_state(&shared.blocking_lock())).is_ok();
            let launched_by_link = match app.deep_link().get_current() {
                Ok(Some(urls)) if !urls.is_empty() => {
                    for url in urls {
                        tauri::async_runtime::spawn(handle_link(app.handle().clone(), shared.clone(), url));
                    }
                    true
                }
                _ => false,
            };
            if !has_tray || !launched_by_link {
                focus(app.handle());
            }
            Ok(())
        })
        // Closing the window keeps the app (and any stream) running in the tray; Quit is in the tray menu.
        .on_window_event(|w, e| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                if w.app_handle().tray_by_id(crate::tray::ID).is_some() {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("couldn't start the app window")
        .run(move |app, event| {
            // Leave the stage properly on the way out, or viewers see a frozen stream until LiveKit times it out.
            if let tauri::RunEvent::Exit = event {
                let s = app.state::<Shared>().inner().clone();
                tauri::async_runtime::block_on(async move {
                    let live = s.lock().await.live.take();
                    if let Some(live) = live {
                        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), live.stop()).await;
                    }
                });
            }
        });
}
