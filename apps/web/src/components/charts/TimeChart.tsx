import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MetricKey, MetricPoint } from "@friends/shared";

export interface Series { key: MetricKey; label: string; color: string }

interface Props {
  title: string;
  series: Series[];
  points: MetricPoint[];
  /** Seconds each point covers; gaps longer than a few steps break the line. */
  step: number;
  /** The window shown, in ms, ending now. */
  span: number;
  /** The latest 10-second sample, for the values next to the title. */
  now: MetricPoint | null;
  format: (v: number) => string;
  /** The y axis never goes below this, so a quiet line doesn't fill the chart. */
  floor?: number;
  height?: number;
}

const PAD = { top: 8, right: 8, bottom: 22, left: 8 };

function niceTicks(max: number, count = 3): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

function timeLabel(t: number, span: number) {
  const opts: Intl.DateTimeFormatOptions = span <= 864e5 ? { hour: "numeric", minute: "2-digit" } : span <= 7 * 864e5 ? { weekday: "short", hour: "numeric" } : { month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(undefined, opts).format(t);
}

const tipTime = (t: number, span: number) =>
  new Intl.DateTimeFormat(undefined, span <= 864e5 ? { hour: "numeric", minute: "2-digit", second: span <= 36e5 ? "2-digit" : undefined } : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(t);

export function TimeChart({ title, series, points, step, span, now, format, floor = 0, height = 150 }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const to = now?.t ?? Date.now();
  const from = to - span;
  const shown = useMemo(() => points.filter((p) => p.t >= from - step * 1000), [points, from, step]);
  const has = (p: MetricPoint) => series.some((s) => p.a[s.key] !== undefined);
  const peak = Math.max(floor, ...shown.flatMap((p) => series.map((s) => p.a[s.key] ?? 0)));
  const ticks = niceTicks(peak);
  const yMax = ticks.at(-1)! || 1;

  const w = Math.max(width - PAD.left - PAD.right, 1);
  const h = height - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - from) / span) * w;
  const y = (v: number) => PAD.top + h - (v / yMax) * h;

  // Each series as runs of points; a missing value or a long gap starts a new run.
  const runs = series.map((s) => {
    const out: Array<Array<[number, number]>> = [];
    let prev: number | null = null;
    for (const p of shown) {
      const v = p.a[s.key];
      if (v === undefined) { prev = null; continue; }
      if (prev === null || p.t - prev > step * 1000 * 3) out.push([]);
      out.at(-1)!.push([x(p.t), y(v)]);
      prev = p.t;
    }
    return out;
  });
  const line = (run: Array<[number, number]>) => run.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(1)},${b.toFixed(1)}`).join("");
  const area = (run: Array<[number, number]>) => `${line(run)}L${run.at(-1)![0].toFixed(1)},${y(0)}L${run[0]![0].toFixed(1)},${y(0)}Z`;

  const xTicks = width < 360 ? 3 : 5;
  const hovered = hover !== null ? shown[hover] : undefined;

  function onMove(e: React.PointerEvent) {
    if (!shown.length) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const t = from + ((e.clientX - rect.left - PAD.left) / w) * span;
    let best = 0;
    for (let i = 1; i < shown.length; i++) if (Math.abs(shown[i]!.t - t) < Math.abs(shown[best]!.t - t)) best = i;
    setHover(has(shown[best]!) ? best : null);
  }

  const single = series.length === 1 ? series[0]! : null;
  const nowVal = (k: MetricKey) => now?.a[k];
  const peakVal = single ? Math.max(...shown.map((p) => p.m[single.key] ?? -Infinity)) : -Infinity;
  const summary = series.map((s) => `${s.label} ${nowVal(s.key) === undefined ? "no data" : format(nowVal(s.key)!)}`).join(", ");

  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <span className="chart-title">{title}</span>
        {single ? (
          <span className="chart-now">
            <span className="mono-num">{nowVal(single.key) === undefined ? "–" : format(nowVal(single.key)!)}</span>
            {Number.isFinite(peakVal) && <span className="quiet mono-num"> · peak {format(peakVal)}</span>}
          </span>
        ) : (
          <ul className="chart-legend">
            {series.map((s) => (
              <li key={s.key}>
                <i style={{ background: s.color }} aria-hidden />
                {s.label} <span className="mono-num">{nowVal(s.key) === undefined ? "–" : format(nowVal(s.key)!)}</span>
              </li>
            ))}
          </ul>
        )}
      </figcaption>
      <div className="chart-plot" ref={wrap} style={{ height }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={`${title}: ${summary}`}>
            {ticks.map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={PAD.left + w} y1={y(v)} y2={y(v)} className="chart-gridline" />
                {v > 0 && <text x={PAD.left + 2} y={y(v) - 4} className="chart-axis">{format(v)}</text>}
              </g>
            ))}
            {Array.from({ length: xTicks }, (_, i) => from + (span * (i + 0.5)) / xTicks).map((t) => (
              <text key={t} x={x(t)} y={height - 6} textAnchor="middle" className="chart-axis">{timeLabel(t, span)}</text>
            ))}
            {single && <path d={runs[0]!.map(area).join("")} fill={single.color} opacity={0.12} />}
            {runs.map((r, i) => <path key={series[i]!.key} d={r.map(line).join("")} fill="none" stroke={series[i]!.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
            {hovered && (
              <g>
                <line x1={x(hovered.t)} x2={x(hovered.t)} y1={PAD.top} y2={PAD.top + h} className="chart-cross" />
                {series.map((s) => hovered.a[s.key] !== undefined && (
                  <circle key={s.key} cx={x(hovered.t)} cy={y(hovered.a[s.key]!)} r={4} fill={s.color} className="chart-dot" />
                ))}
              </g>
            )}
          </svg>
        )}
        {width > 0 && !shown.some(has) && <p className="chart-empty quiet">No data yet</p>}
        {hovered && (
          <div className="chart-tip" style={{ left: Math.min(Math.max(x(hovered.t), 80), width - 80) }}>
            <span className="quiet">{tipTime(hovered.t, span)}</span>
            {series.map((s) => hovered.a[s.key] !== undefined && (
              <span key={s.key}>
                <i style={{ background: s.color }} aria-hidden />
                {series.length > 1 && `${s.label} `}
                <strong className="mono-num">{format(hovered.a[s.key]!)}</strong>
                {step > 10 && hovered.m[s.key] !== undefined && <span className="quiet mono-num"> · peak {format(hovered.m[s.key]!)}</span>}
              </span>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
