//! The app window. The site opens friends://live?code=…&server=…; the app trades the code for a stage token
//! and goes live with the saved sound and quality. Everything about the stream is controlled from here.

use crate::session::{self, Quality, Session, QUALITIES};
use crate::audio::{self, AudioApp};
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
    /// App name whose sound to stream; None for no sound.
    sound: Option<String>,
    quality: String,
    /// Go live as soon as the site opens the app.
    auto_start: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { sound: None, quality: QUALITIES[0].id.into(), auto_start: true }
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
struct Inner {
    link: Option<Link>,
    live: Option<Session>,
    starting: bool,
    error: Option<String>,
    settings: Settings,
}

type Shared = Arc<Mutex<Inner>>;

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
    sound: Option<String>,
}

fn view(i: &Inner) -> View {
    View {
        name: i.link.as_ref().map(|l| l.name.clone()),
        server: i.link.as_ref().map(|l| l.server.clone()).filter(|s| s != DEFAULT_SERVER),
        starting: i.starting,
        live: i.live.as_ref().map(|s| LiveView { detail: format!("{}×{}", s.width, s.height), sound: s.sound_from.clone() }),
        error: i.error.clone(),
        settings: i.settings.clone(),
        qualities: QUALITIES,
        picker: crate::video::needs_os_picker(),
    }
}

async fn emit(app: &AppHandle, shared: &Shared) {
    let v = view(&*shared.lock().await);
    let _ = app.emit("state", v);
}

#[tauri::command]
async fn get_state(shared: State<'_, Shared>) -> Result<View, ()> {
    Ok(view(&*shared.lock().await))
}

#[tauri::command]
async fn list_apps() -> Result<Vec<AudioApp>, String> {
    tokio::task::spawn_blocking(audio::list_apps).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_settings(app: AppHandle, shared: State<'_, Shared>, settings: Settings) -> Result<(), ()> {
    save_settings_file(&settings);
    shared.lock().await.settings = settings;
    emit(&app, &shared).await;
    Ok(())
}

#[tauri::command]
async fn go_live(app: AppHandle, shared: State<'_, Shared>) -> Result<(), ()> {
    start_live(app, shared.inner().clone()).await;
    Ok(())
}

#[tauri::command]
async fn stop(app: AppHandle, shared: State<'_, Shared>) -> Result<(), ()> {
    let s = shared.lock().await.live.take();
    if let Some(s) = s {
        s.stop().await;
    }
    emit(&app, &shared).await;
    Ok(())
}

#[tauri::command]
async fn open_site(shared: State<'_, Shared>) -> Result<(), ()> {
    let url = shared.lock().await.link.as_ref().map(|l| l.server.clone()).unwrap_or_else(|| DEFAULT_SERVER.into());
    open_url(&url);
    Ok(())
}

fn open_url(url: &str) {
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(url).spawn();
    #[cfg(not(target_os = "windows"))]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
}

async fn start_live(app: AppHandle, shared: Shared) {
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

    // The sound is remembered by app name; if that app isn't playing anything right now, go live without it.
    let mut note = None;
    let sound = match &settings.sound {
        None => None,
        Some(name) => {
            let apps = tokio::task::spawn_blocking(audio::list_apps).await.ok().and_then(|r| r.ok()).unwrap_or_default();
            let found = apps.into_iter().find(|a| a.name.eq_ignore_ascii_case(name));
            if found.is_none() {
                note = Some(format!("{name} isn't playing sound, so the stream has none. Pick it again once it is."));
            }
            found
        }
    };

    let opts = session::Options::from_quality(session::quality(&settings.quality), sound);
    let result = Session::start(&url, &token, opts).await;

    let mut i = shared.lock().await;
    i.starting = false;
    match result {
        Ok((s, mut events)) => {
            i.live = Some(s);
            i.error = note;
            drop(i);
            // Ended from the site (the X), by a moderator, or the connection dropped for good.
            let (app2, shared2) = (app.clone(), shared.clone());
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = events.recv().await {
                    if let RoomEvent::Disconnected { .. } = ev {
                        break;
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

fn focus(app: &AppHandle) {
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
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| focus(app)))
        .plugin(tauri_plugin_deep_link::init())
        .manage(shared.clone())
        .invoke_handler(tauri::generate_handler![get_state, list_apps, save_settings, go_live, stop, open_site])
        .setup(move |app| {
            // Installed builds register friends:// at install time; this covers running a bare binary.
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            if let Err(e) = app.deep_link().register_all() {
                log::warn!("couldn't register friends:// links: {e}");
            }
            let handle = app.handle().clone();
            let s = shared.clone();
            app.deep_link().on_open_url(move |event| {
                focus(&handle);
                for url in event.urls() {
                    tauri::async_runtime::spawn(handle_link(handle.clone(), s.clone(), url));
                }
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    tauri::async_runtime::spawn(handle_link(app.handle().clone(), shared.clone(), url));
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("couldn't start the app window");
}
