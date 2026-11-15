import { useEffect, useRef, useState } from "react";
import { AudioLines, X } from "lucide-react";
import type { Playback } from "@friends/shared";
import { expectedPosition } from "../../lib/media";

export const PRESETS = [
  { id: "bars", label: "Bars" },
  { id: "scope", label: "Scope" },
  { id: "ambience", label: "Ambience" },
  { id: "battery", label: "Battery" },
] as const;
export type Preset = (typeof PRESETS)[number]["id"];

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

  async capture(): Promise<string | null> {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        // @ts-expect-error Chromium-only hints
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        systemAudio: "include",
      });
      stream.getVideoTracks().forEach((t) => t.stop());
      if (!stream.getAudioTracks().length) return "No audio was shared. Pick this tab and turn on “Share tab audio”.";
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.75;
      src.connect(this.analyser); // not to the destination: the page already plays the sound
      this.stream = stream;
      stream.getAudioTracks()[0]!.addEventListener("ended", () => this.release());
      return null;
    } catch {
      return "Audio capture was cancelled or isn’t supported in this browser.";
    }
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

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  return { glow: cs.getPropertyValue("--glow").trim() || "#2a4f8f", ink: cs.getPropertyValue("--ink").trim() || "#e6ecf5" };
}

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
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let colors = readColors();
    let colorAt = 0;
    const peaks = new Float32Array(BINS);
    const t0 = performance.now();

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (now - colorAt > 1000) (colors = readColors()), (colorAt = now);
      const t = (now - t0) / 1000 * (reduce ? 0.25 : 1);
      const src = source.current;
      src.update(latest.current, t);
      const s = src.spectrum;

      if (preset === "bars") {
        ctx.clearRect(0, 0, w, h);
        const n = 48;
        const gap = 3;
        const bw = (w - gap * (n - 1)) / n;
        const base = h * 0.78;
        for (let i = 0; i < n; i++) {
          const v = s[Math.floor((i / n) * BINS)]!;
          const bh = v * base * 0.9;
          peaks[i] = Math.max(v, (peaks[i] ?? 0) - 0.008);
          const x = i * (bw + gap);
          const g = ctx.createLinearGradient(0, base - bh, 0, base);
          g.addColorStop(0, colors.ink);
          g.addColorStop(1, colors.glow);
          ctx.fillStyle = g;
          ctx.fillRect(x, base - bh, bw, bh);
          ctx.globalAlpha = 0.22;
          ctx.fillRect(x, base + 2, bw, bh * 0.35);
          ctx.globalAlpha = 1;
          ctx.fillStyle = colors.ink;
          ctx.fillRect(x, base - peaks[i]! * base * 0.9 - 4, bw, 2);
        }
      } else if (preset === "scope") {
        ctx.fillStyle = "rgb(0 0 0 / 0.18)";
        ctx.fillRect(0, 0, w, h);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = colors.ink;
        ctx.shadowColor = colors.glow;
        ctx.shadowBlur = 14;
        ctx.beginPath();
        for (let i = 0; i < 128; i++) {
          const x = (i / 127) * w;
          const y = h / 2 + src.wave[i]! * h * 0.38;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else if (preset === "ambience") {
        ctx.fillStyle = "rgb(0 0 0 / 0.08)";
        ctx.fillRect(0, 0, w, h);
        const cx = w / 2;
        const cy = h / 2;
        const bass = (s[1]! + s[2]! + s[3]!) / 3;
        for (let ring = 0; ring < 3; ring++) {
          ctx.beginPath();
          for (let a = 0; a <= 120; a++) {
            const ang = (a / 120) * Math.PI * 2;
            const v = s[(a * 3 + ring * 11) % BINS]!;
            const r = Math.min(w, h) * (0.16 + ring * 0.09) * (1 + bass * 0.6) + v * 40 + Math.sin(ang * (3 + ring) + t * (0.6 + ring * 0.3)) * 14;
            const x = cx + Math.cos(ang + t * 0.15 * (ring + 1)) * r;
            const y = cy + Math.sin(ang + t * 0.15 * (ring + 1)) * r;
            if (a === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = ring === 1 ? colors.ink : colors.glow;
          ctx.globalAlpha = 0.55 - ring * 0.12;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else {
        // battery: kaleidoscope of rotating shapes, six-fold symmetry
        ctx.fillStyle = "rgb(0 0 0 / 0.12)";
        ctx.fillRect(0, 0, w, h);
        ctx.save();
        ctx.translate(w / 2, h / 2);
        const level = s.reduce((a, b) => a + b, 0) / BINS;
        for (let k = 0; k < 6; k++) {
          ctx.rotate(Math.PI / 3);
          for (let j = 0; j < 5; j++) {
            const v = s[j * 9]!;
            const d = 30 + j * Math.min(w, h) * 0.07 + v * 50;
            ctx.save();
            ctx.rotate(t * (0.2 + j * 0.07) * (j % 2 ? -1 : 1));
            ctx.beginPath();
            const size = 8 + v * 38 + level * 20;
            for (let q = 0; q < 3; q++) {
              const ang = (q / 3) * Math.PI * 2;
              const x = d + Math.cos(ang) * size;
              const y = Math.sin(ang) * size;
              if (q === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.strokeStyle = j % 2 ? colors.ink : colors.glow;
            ctx.globalAlpha = 0.35 + v * 0.6;
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.restore();
          }
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [preset]);

  return (
    <>
      <canvas ref={canvas} className="viz-canvas" aria-hidden />
      <div className="viz-audio">
        {live ? (
          <button className="btn btn-quiet btn-s" onClick={() => { source.current.release(); setLive(false); }}><X aria-hidden />Stop reacting to audio</button>
        ) : (
          <button className="btn btn-quiet btn-s" title="Captures this tab’s sound (Chrome or Edge)"
            onClick={async () => { setError(await source.current.capture()); setLive(source.current.live); }}>
            <AudioLines aria-hidden />React to real audio
          </button>
        )}
        {error && <span className="field-error">{error}</span>}
      </div>
    </>
  );
}
