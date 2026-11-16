const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
let state = null;

function render() {
  const s = state;
  if (!s) return;

  $("who").textContent = s.name ? `Streaming as ${s.name}${s.server ? ` on ${s.server}` : ""}` : "";

  const status = $("status");
  status.classList.toggle("is-live", Boolean(s.live));
  status.classList.toggle("is-busy", s.starting);
  if (s.live) {
    $("status-title").textContent = s.live.window ? `Live: ${s.live.window}` : "Live: whole screen";
    const sound = s.live.sound ? `sound from ${s.live.sound}` : s.live.window ? "no sound yet: the app isn't playing any" : "no sound";
    $("status-detail").textContent = `${s.live.detail} · ${sound}`;
  } else if (s.starting) {
    $("status-title").textContent = "Starting…";
    $("status-detail").textContent = s.picker && !s.settings.restoreToken ? "Choose a window in the system dialog." : "Connecting to the stage.";
  } else if (s.name) {
    $("status-title").textContent = "Ready";
    $("status-detail").textContent = "Not streaming.";
  } else {
    $("status-title").textContent = "Not connected";
    $("status-detail").textContent = "Press Go live on the site to connect this app.";
  }

  $("error").hidden = !s.error;
  $("error").textContent = s.error ?? "";

  const primary = $("primary");
  primary.textContent = s.live ? "Stop streaming" : s.starting ? "Starting…" : "Go live";
  primary.classList.toggle("is-stop", Boolean(s.live));
  primary.disabled = s.starting || (!s.live && !s.name);

  $("window").textContent = s.settings.window ?? (s.settings.restoreToken ? "Whole screen" : "You'll choose one when you go live");
  $("change").hidden = !s.settings.restoreToken && !s.live;
  $("change").disabled = s.starting;

  const q = $("quality");
  if (!q.options.length) {
    for (const x of s.qualities) q.add(new Option(`${x.label} · ${x.detail}`, x.id));
  }
  q.value = s.settings.quality;
  q.disabled = Boolean(s.live) || s.starting; // takes effect from the next Go live
  $("auto").checked = s.settings.startAtLogin;

  for (const [id, list, value] of [["codec", s.codecs, s.settings.codec], ["encoder", s.encoders, s.settings.encoder]]) {
    const sel = $(id);
    if (!sel.options.length) for (const [v, label] of list) sel.add(new Option(label, v));
    sel.value = value;
    sel.disabled = Boolean(s.live) || s.starting;
  }
}

const save = () => invoke("save_settings", { quality: $("quality").value, startAtLogin: $("auto").checked });

$("primary").addEventListener("click", () => invoke(state?.live ? "stop" : "go_live"));
$("site").addEventListener("click", () => invoke("open_site"));
$("change").addEventListener("click", () => invoke("change_window"));
$("quality").addEventListener("change", save);
$("auto").addEventListener("change", save);
const saveVideo = () => invoke("save_video", { codec: $("codec").value, encoder: $("encoder").value });
$("codec").addEventListener("change", saveVideo);
$("encoder").addEventListener("change", saveVideo);

listen("state", (e) => {
  state = e.payload;
  render();
});

(async () => {
  state = await invoke("get_state");
  render();
})();
