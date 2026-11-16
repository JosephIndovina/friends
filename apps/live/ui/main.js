const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
let state = null;
let apps = [];

function render() {
  const s = state;
  if (!s) return;

  $("who").textContent = s.name ? `Streaming as ${s.name}${s.server ? ` on ${s.server}` : ""}` : "";

  const status = $("status");
  status.classList.toggle("is-live", Boolean(s.live));
  status.classList.toggle("is-busy", s.starting);
  if (s.live) {
    $("status-title").textContent = "Live";
    $("status-detail").textContent = `${s.live.detail} · ${s.live.sound ? `sound from ${s.live.sound}` : "no sound"}`;
  } else if (s.starting) {
    $("status-title").textContent = "Starting…";
    $("status-detail").textContent = s.picker ? "Choose a window or screen in the system dialog." : "Connecting to the stage.";
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

  renderSound();
  const q = $("quality");
  if (!q.options.length) {
    for (const x of s.qualities) q.add(new Option(`${x.label} · ${x.detail}`, x.id));
  }
  q.value = s.settings.quality;
  $("auto").checked = s.settings.autoStart;

  // Changing these mid-stream would need a restart; stop first.
  for (const id of ["sound", "quality", "refresh"]) $(id).disabled = Boolean(s.live) || s.starting;
}

function renderSound() {
  const sel = $("sound");
  const want = state?.settings.sound ?? "";
  const names = [...new Set(apps.map((a) => a.name))];
  // Keep the saved choice listed even while that app is quiet.
  if (want && !names.includes(want)) names.push(want);
  sel.replaceChildren(new Option("No sound", ""), ...names.map((n) => new Option(n, n)));
  sel.value = want;
}

async function refreshApps() {
  try {
    apps = await invoke("list_apps");
  } catch {
    apps = [];
  }
  renderSound();
}

async function save(patch) {
  await invoke("save_settings", { settings: { ...state.settings, ...patch } });
}

$("primary").addEventListener("click", () => invoke(state?.live ? "stop" : "go_live"));
$("site").addEventListener("click", () => invoke("open_site"));
$("refresh").addEventListener("click", refreshApps);
$("sound").addEventListener("change", (e) => save({ sound: e.target.value || null }));
$("quality").addEventListener("change", (e) => save({ quality: e.target.value }));
$("auto").addEventListener("change", (e) => save({ autoStart: e.target.checked }));

listen("state", (e) => {
  state = e.payload;
  render();
});
window.addEventListener("focus", refreshApps);

(async () => {
  state = await invoke("get_state");
  render();
  refreshApps();
})();
