import { useEffect, useRef, useState } from "react";
import { AudioLines, X } from "lucide-react";
import type { Playback } from "@friends/shared";
import { expectedPosition } from "../../lib/media";

export const PRESETS = [
  { id: "alchemy", label: "Alchemy" },
  { id: "battery", label: "Battery" },
  { id: "bars", label: "Bars and Waves" },
  { id: "ambience", label: "Ambience" },
  { id: "tunnel", label: "Tunnel" },
  { id: "shuffle", label: "Shuffle" },
] as const;
export type Preset = (typeof PRESETS)[number]["id"];
type Drawn = Exclude<Preset, "shuffle">;
const CYCLE: Drawn[] = ["alchemy", "battery", "ambience", "tunnel", "bars"];
const SHUFFLE_MS = 30_000;

const BINS = 64;

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Audio data for the visualizer. YouTube's player is a cross-origin iframe, so its sound can't be
 * analysed directly. By default the data is generated from the synced clock and the track (everyone
 * sees the same thing); "React to real audio" captures this tab's sound instead (Chromium only).
 */
class Source {
  spectrum = new Float32Array(BINS);
  wave = new Float32Array(128);
  private analyser: AnalyserNode | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private fbuf = new Uint8Array(128);
  private tbuf = new Uint8Array(256);

  get live() {
    return Boolean(this.analyser);
  }

  /** Capture this tab's audio only: no other tabs, windows, screens or system audio. */
  async capture(): Promise<string | null> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
        // Chromium hints: offer this tab first, never system audio, no switching to other surfaces.
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        systemAudio: "exclude",
        surfaceSwitching: "exclude",
        monitorTypeSurfaces: "exclude",
      } as DisplayMediaStreamOptions);
    } catch {
      return "Audio capture was cancelled or isn’t supported in this browser.";
    }
    const video = stream.getVideoTracks()[0];
    const surface = video?.getSettings().displaySurface;
    stream.getVideoTracks().forEach((t) => t.stop());
    if (surface && surface !== "browser") {
      stream.getTracks().forEach((t) => t.stop());
      return "Only this tab’s audio can be used. Choose “This tab” when the browser asks.";
    }
    if (!stream.getAudioTracks().length) return "No audio was shared. Choose this tab and turn on “Share tab audio”.";
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.75;
    src.connect(this.analyser); // not to the destination: the page already plays the sound
    this.stream = stream;
    stream.getAudioTracks()[0]!.addEventListener("ended", () => this.release());
    return null;
  }

  release() {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.analyser = null;
    this.ctx = null;
    this.stream = null;
  }

  update(p: Playback | null, t: number) {
    if (this.analyser) {
      this.analyser.getByteFrequencyData(this.fbuf);
      for (let i = 0; i < BINS; i++) this.spectrum[i] = (this.fbuf[i * 2]! + this.fbuf[i * 2 + 1]!) / 510;
      this.analyser.getByteTimeDomainData(this.tbuf);
      for (let i = 0; i < 128; i++) this.wave[i] = (this.tbuf[i * 2]! - 128) / 128;
      return;
    }
    const playing = Boolean(p?.playing);
    const seed = p ? hash(p.item.ref) : 1;
    const pos = p ? expectedPosition(p) : 0;
    const bpm = 84 + (seed % 60);
    const phase = ((pos * bpm) / 60) % 1;
    const kick = Math.exp(-phase * 7);
    const energy = 0.55 + 0.45 * Math.sin(pos * 0.21 + (seed % 7));
    for (let i = 0; i < BINS; i++) {
      const tilt = 0.75 * Math.exp(-i / 20) + 0.18;
      const wob = 0.5 + 0.5 * Math.sin(pos * (1.1 + ((seed >> (i % 24)) & 7) * 0.37) + i * 0.9);
      const hit = i < 8 ? kick : i < 24 ? kick * 0.45 : 0.15 * kick;
      const target = playing ? Math.min(1, tilt * energy * (0.45 + 0.55 * wob) + hit * 0.5) : 0;
      this.spectrum[i] = this.spectrum[i]! + (target - this.spectrum[i]!) * 0.25;
    }
    for (let i = 0; i < 128; i++) {
      const x = i / 128;
      const a = playing ? 0.35 + 0.4 * kick : 0;
      this.wave[i] = a * (Math.sin(x * 12 + t * 3.1) * 0.6 + Math.sin(x * 31 - t * 5.3) * 0.3 + Math.sin(x * 77 + t * 1.7) * 0.1);
    }
  }
}

/** Hue of the room's glow (taken from the artwork), so each track gets its own colour family. */
function glowHue(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--glow").trim();
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.fillStyle = raw || "#2a4f8f";
  const hex = probe.fillStyle;
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 220;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x!, 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 220;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

const MAX_W = 1100; // render resolution cap: feedback effects redraw the whole frame every tick

export function Visualizer({ playback, preset }: { playback: Playback | null; preset: Preset }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(playback);
  latest.current = playback;
  const source = useRef(new Source());
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => source.current.release(), []);

  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    const back = document.createElement("canvas"); // previous frame, for feedback trails
    const bctx = back.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const peaks = new Float32Array(BINS);
    let raf = 0;
    let hue = glowHue();
    let hueAt = 0;
    let lastKick = 0;
    const t0 = performance.now();

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const scale = Math.min(1, MAX_W / Math.max(1, el.clientWidth));
      const w = Math.max(1, Math.round(el.clientWidth * scale));
      const h = Math.max(1, Math.round(el.clientHeight * scale));
      // Size both canvases independently: a fresh trail buffer (after a preset switch) starts at 300x150.
      if (el.width !== w || el.height !== h) {
        el.width = w;
        el.height = h;
      }
      if (back.width !== w || back.height !== h) {
        back.width = w;
        back.height = h;
      }
      if (now - hueAt > 2000) (hue = glowHue()), (hueAt = now);
      const t = ((now - t0) / 1000) * (reduce ? 0.3 : 1);
      const src = source.current;
      src.update(latest.current, t);
      const s = src.spectrum;
      const wave = src.wave;
      const bass = (s[0]! + s[1]! + s[2]! + s[3]!) / 4;
      const mid = (s[10]! + s[14]! + s[18]! + s[22]!) / 4;
      const level = s.reduce((a, b) => a + b, 0) / BINS;
      const kick = bass > 0.55 && now - lastKick > 220;
      if (kick) lastKick = now;
      const H = (o = 0) => (hue + o + t * 18) % 360;
      const mode: Drawn = preset === "shuffle" ? CYCLE[Math.floor((now - t0) / SHUFFLE_MS) % CYCLE.length]! : preset;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h);

      // Feedback: redraw the last frame transformed and faded, so everything leaves trails.
      const feedback = (zoom: number, rot: number, fade: number, dx = 0, dy = 0) => {
        bctx.clearRect(0, 0, w, h);
        bctx.drawImage(el, 0, 0);
        ctx.fillStyle = `rgb(0 0 0 / ${1 - fade})`;
        ctx.globalCompositeOperation = "source-over";
        ctx.save();
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = fade;
        ctx.translate(cx + dx, cy + dy);
        ctx.rotate(rot);
        ctx.scale(zoom, zoom);
        ctx.drawImage(back, -cx, -cy);
        ctx.restore();
        ctx.globalAlpha = 1;
      };

      if (mode === "alchemy") {
        feedback(1.012 + bass * 0.03, 0.004 + mid * 0.01, 0.94);
        ctx.globalCompositeOperation = "lighter";
        for (let k = 0; k < 3; k++) {
          ctx.beginPath();
          for (let i = 0; i <= 128; i++) {
            const a = (i / 128) * Math.PI * 2 + t * (0.3 + k * 0.15) * (k % 2 ? -1 : 1);
            const r = R * (0.12 + k * 0.07) * (1 + bass * 0.5) + wave[i % 128]! * R * 0.12;
            const x = cx + Math.cos(a) * r;
            const y = cy + Math.sin(a) * r;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = `hsl(${H(k * 70)} 95% ${55 + level * 25}%)`;
          ctx.lineWidth = 2 + bass * 4;
          ctx.stroke();
        }
        if (kick) {
          ctx.beginPath();
          ctx.arc(cx, cy, R * 0.05, 0, Math.PI * 2);
          ctx.fillStyle = `hsl(${H(180)} 100% 70%)`;
          ctx.fill();
        }
      } else if (mode === "battery") {
        feedback(0.985 - bass * 0.02, -0.012 - level * 0.02, 0.935);
        ctx.globalCompositeOperation = "lighter";
        ctx.save();
        ctx.translate(cx, cy);
        const arms = 8;
        for (let k = 0; k < arms; k++) {
          ctx.rotate((Math.PI * 2) / arms);
          for (let j = 0; j < 6; j++) {
            const v = s[j * 8 + 2]!;
            const d = R * (0.06 + j * 0.065) + v * R * 0.08;
            const size = R * (0.015 + v * 0.06);
            ctx.save();
            ctx.translate(d, 0);
            ctx.rotate(t * (1 + j * 0.3) * (j % 2 ? -1 : 1));
            ctx.beginPath();
            for (let q = 0; q < 3; q++) {
              const ang = (q / 3) * Math.PI * 2;
              ctx.lineTo(Math.cos(ang) * size, Math.sin(ang) * size);
            }
            ctx.closePath();
            ctx.fillStyle = `hsl(${H(j * 40 + k * 8)} 95% ${45 + v * 30}% / ${0.25 + v * 0.6})`;
            ctx.fill();
            ctx.restore();
          }
        }
        ctx.restore();
      } else if (mode === "ambience") {
        feedback(1.004, 0.0015, 0.93, 0, -0.6);
        ctx.globalCompositeOperation = "lighter";
        for (let k = 0; k < 4; k++) {
          ctx.beginPath();
          for (let i = 0; i <= 160; i++) {
            const p = i / 160;
            const a = p * Math.PI * 2;
            const x = cx + Math.sin(a * (2 + k) + t * (0.7 + k * 0.2)) * w * (0.28 + s[k * 6]! * 0.15);
            const y = cy + Math.sin(a * (3 + k) + t * (0.5 + k * 0.13) + k) * h * (0.26 + s[k * 6 + 3]! * 0.15);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = `hsl(${H(k * 50)} 90% 55% / 0.3)`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      } else if (mode === "tunnel") {
        feedback(1.028 + bass * 0.03, 0.006 + mid * 0.012, 0.9);
        ctx.globalCompositeOperation = "lighter";
        const sides = 6;
        ctx.beginPath();
        for (let i = 0; i <= sides; i++) {
          const a = (i / sides) * Math.PI * 2 + t * 0.4;
          const r = R * (0.06 + level * 0.14);
          ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        }
        ctx.strokeStyle = `hsl(${H()} 100% ${45 + bass * 20}% / 0.85)`;
        ctx.lineWidth = 4 + bass * 8;
        ctx.stroke();
        // spectrum star at the mouth of the tunnel
        for (let i = 0; i < 32; i++) {
          const v = s[i * 2]!;
          const a = (i / 32) * Math.PI * 2 - t * 0.6;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * R * 0.02, cy + Math.sin(a) * R * 0.02);
          ctx.lineTo(cx + Math.cos(a) * R * (0.03 + v * 0.1), cy + Math.sin(a) * R * (0.03 + v * 0.1));
          ctx.strokeStyle = `hsl(${H(120 + i * 4)} 95% 65% / ${0.4 + v * 0.6})`;
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      } else {
        // Bars and Waves: spectrum bars with falling peak caps, a reflection, and the waveform across the top.
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "rgb(0 0 0 / 0.35)";
        ctx.fillRect(0, 0, w, h);
        const n = 40;
        const gap = Math.max(2, w * 0.004);
        const bw = (w - gap * (n - 1)) / n;
        const base = h * 0.72;
        for (let i = 0; i < n; i++) {
          const v = s[Math.floor((i / n) * BINS)]!;
          const bh = v * base * 0.92;
          peaks[i] = Math.max(v, (peaks[i] ?? 0) - 0.006);
          const x = i * (bw + gap);
          const g = ctx.createLinearGradient(0, base - bh, 0, base);
          g.addColorStop(0, `hsl(${H(i * 4)} 95% 65%)`);
          g.addColorStop(1, `hsl(${H(i * 4 + 40)} 90% 35%)`);
          ctx.fillStyle = g;
          ctx.fillRect(x, base - bh, bw, bh);
          ctx.globalAlpha = 0.2;
          ctx.fillRect(x, base + 3, bw, bh * 0.4);
          ctx.globalAlpha = 1;
          ctx.fillStyle = "#fff";
          ctx.fillRect(x, base - peaks[i]! * base * 0.92 - 4, bw, 2);
        }
        ctx.beginPath();
        for (let i = 0; i < 128; i++) {
          const x = (i / 127) * w;
          const y = h * 0.18 + wave[i]! * h * 0.12;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `hsl(${H(160)} 95% 70%)`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [preset]);

  return (
    <>
      <canvas ref={canvas} className="viz-canvas" aria-hidden />
      <div className="viz-audio">
        {live ? (
          <button className="btn btn-quiet btn-s" onClick={() => { source.current.release(); setLive(false); }}><X aria-hidden />Stop using tab audio</button>
        ) : (
          <button className="btn btn-primary btn-s" title="Uses this tab’s sound only, so the visuals follow the actual music (Chrome or Edge)"
            onClick={async () => { setError(await source.current.capture()); setLive(source.current.live); }}>
            <AudioLines aria-hidden />React to real audio
          </button>
        )}
        {error && <span className="field-error">{error}</span>}
      </div>
    </>
  );
}
