/**
 * Temporary: a timeline of what happens around a Twitch player pausing itself. Off unless turned on in this browser:
 *   localStorage.debugTwitch = "1"; location.reload()
 * Everything is logged to the console as [twitch] lines and kept in window.__twitchLog (copy(__twitchLog) in devtools).
 */

let on = false;
try {
  on = localStorage.getItem("debugTwitch") === "1";
} catch {
  /* off */
}
export const twitchDebug = on;

const t0 = performance.now();
const log: unknown[] = [];
if (on) (window as unknown as { __twitchLog: unknown[] }).__twitchLog = log;

export function tlog(what: string, data?: unknown) {
  if (!on) return;
  const ms = Math.round(performance.now() - t0);
  log.push(data === undefined ? [ms, what] : [ms, what, data]);
  console.log(`[twitch] ${ms}ms ${what}`, data ?? "");
}

const describe = (el: Element | null) => {
  if (!el) return null;
  const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}`;
};

/** What's drawn on top at the player's centre and corners, and anything above it that fades or transforms it. */
export function tsnapshot(host: HTMLElement, why: string) {
  if (!on) return;
  const frame = host.querySelector("iframe");
  if (!frame) return tlog(`${why}: no iframe`);
  const r = frame.getBoundingClientRect();
  const pts: Record<string, [number, number]> = {
    centre: [r.left + r.width / 2, r.top + r.height / 2],
    tl: [r.left + 4, r.top + 4],
    tr: [r.right - 4, r.top + 4],
    bl: [r.left + 4, r.bottom - 4],
    br: [r.right - 4, r.bottom - 4],
  };
  const covers: Record<string, string | null> = {};
  for (const [k, [x, y]] of Object.entries(pts)) {
    const top = document.elementFromPoint(x, y);
    covers[k] = top === frame ? "iframe (clear)" : x < 0 || y < 0 || x > innerWidth || y > innerHeight ? "off screen" : describe(top);
  }
  const effects: string[] = [];
  for (let el: Element | null = frame; el; el = el.parentElement) {
    const cs = getComputedStyle(el);
    const bits = [
      cs.opacity !== "1" && `opacity ${cs.opacity}`,
      cs.transform !== "none" && `transform ${cs.transform}`,
      cs.filter !== "none" && `filter ${cs.filter}`,
      cs.visibility !== "visible" && `visibility ${cs.visibility}`,
      cs.mask && cs.mask !== "none" && `mask`,
    ].filter(Boolean);
    if (bits.length) effects.push(`${describe(el)}: ${bits.join(", ")}`);
  }
  const dock = host.closest(".dock");
  tlog(why, {
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    dock: dock?.className,
    covers,
    effects,
    focus: describe(document.activeElement),
    hidden: document.hidden,
  });
}

/** Chrome's own judgement of whether the player is visible (what an embed can see), and every move or resize of it. */
export function twatch(host: HTMLElement): () => void {
  if (!on) return () => {};
  let io: IntersectionObserver | null = null;
  let raf = 0;
  let last = "";
  let observed: Element | null = null;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const frame = host.querySelector("iframe");
    if (frame && frame !== observed) {
      observed = frame;
      io?.disconnect();
      try {
        io = new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              const v = (e as IntersectionObserverEntry & { isVisible?: boolean }).isVisible;
              tlog(`visibility: ${v === undefined ? "n/a" : v ? "VISIBLE" : "NOT VISIBLE"}, ${Math.round(e.intersectionRatio * 100)}% on screen`);
              if (v === false) tsnapshot(host, "not visible");
            }
          },
          { threshold: [0, 0.5, 1], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
        );
        io.observe(frame);
      } catch (err) {
        tlog("visibility observer unavailable", String(err));
      }
    }
    if (!frame) return;
    const r = frame.getBoundingClientRect();
    const dock = host.closest(".dock")?.className ?? "";
    const key = `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} ${dock}`;
    if (key !== last) {
      last = key;
      tlog(`player at ${key}`);
    }
  };
  tick();
  return () => {
    cancelAnimationFrame(raf);
    io?.disconnect();
  };
}
