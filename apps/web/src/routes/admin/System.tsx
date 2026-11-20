import { useEffect, useState } from "react";
import { Download, TriangleAlert } from "lucide-react";
import type { MetricKey, MetricPoint, MetricRange, MetricsResponse } from "@friends/shared";
import { TimeChart, type Series } from "../../components/charts/TimeChart";
import { LoadError, Loading, PageHead } from "../../components/settings/ui";
import { api } from "../../lib/api";
import { ago, bytes, errorText } from "../../lib/format";
import { useLoad } from "./useLoad";

const RANGES: Array<{ id: MetricRange; label: string; span: number }> = [
  { id: "1h", label: "1 hour", span: 36e5 },
  { id: "24h", label: "24 hours", span: 864e5 },
  { id: "7d", label: "7 days", span: 7 * 864e5 },
  { id: "30d", label: "30 days", span: 30 * 864e5 },
];
const RANGE_KEY = "friends.system.range";

// ---------- formatting ----------

/** Bandwidth in bits per second, from bytes per second. */
export function bitrate(bytesPerSec: number): string {
  const b = bytesPerSec * 8;
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} Gb/s`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(b >= 1e7 ? 0 : 1)} Mb/s`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} kb/s`;
  return `${Math.round(b)} b/s`;
}
const pct = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
const ms = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`;
const count = (v: number) => (v < 10 && v % 1 ? v.toFixed(1) : Math.round(v).toLocaleString());
const perMin = (v: number) => `${count(v * 60)}/min`;

const IN = "var(--series-1)";
const OUT = "var(--series-2)";
const one = (key: MetricKey, label: string): Series[] => [{ key, label, color: IN }];

/** Total bytes over the range from a per-second rate. */
const total = (points: MetricPoint[], key: MetricKey, step: number) => points.reduce((s, p) => s + (p.a[key] ?? 0) * step, 0);

// ---------- data ----------

function useMetrics(range: MetricRange) {
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (!document.hidden) {
        try {
          const d = await api<MetricsResponse>("GET", `/api/admin/metrics?range=${range}`);
          if (alive) (setData(d), setError(null));
        } catch (e) {
          if (alive) setError(errorText(e));
        }
      }
      if (alive) timer = setTimeout(load, range === "1h" ? 10_000 : 60_000);
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [range]);
  return { data: data?.range === range ? data : null, error };
}

// ---------- page ----------

export function System() {
  const [range, setRange] = useState<MetricRange>(() => {
    try {
      const v = localStorage.getItem(RANGE_KEY);
      return RANGES.some((r) => r.id === v) ? (v as MetricRange) : "1h";
    } catch {
      return "1h";
    }
  });
  const pick = (r: MetricRange) => {
    setRange(r);
    try { localStorage.setItem(RANGE_KEY, r); } catch { /* private mode */ }
  };
  const { data, error } = useMetrics(range);
  const span = RANGES.find((r) => r.id === range)!.span;

  return (
    <div className="pane pane-wide">
      <PageHead title="System" note={range === "1h" ? "Updates every 10 seconds." : "Updates every minute."}
        actions={
          <div className="segmented segmented-s" role="radiogroup" aria-label="Time range">
            {RANGES.map((r) => (
              <label key={r.id}>
                <input type="radio" name="system-range" checked={range === r.id} onChange={() => pick(r.id)} />
                <span>{r.label}</span>
              </label>
            ))}
          </div>
        } />
      {error && !data ? <LoadError text={error} /> : !data ? <Loading rows={4} /> : <Metrics d={data} span={span} />}
      <ServerPanel />
    </div>
  );
}

function Metrics({ d, span }: { d: MetricsResponse; span: number }) {
  const c = { points: d.points, step: d.step, span, now: d.now };
  const n = d.now?.a ?? {};
  const lkOn = d.livekit.configured && !d.livekit.error;
  const sent = (k: MetricKey) => bytes(total(d.points, k, d.step));
  const memFmt = (v: number) => bytes(v);

  return (
    <>
      <dl className="stat-row">
        <Stat label="Cast upload" value={lkOn && n.lkTx !== undefined ? bitrate(n.lkTx) : "–"} />
        <Stat label="App upload" value={n.tx !== undefined ? bitrate(n.tx) : "–"} />
        <Stat label="App CPU" value={n.cpu !== undefined ? pct(n.cpu) : "–"} />
        <Stat label="App memory" value={n.mem !== undefined ? bytes(n.mem) : "–"} />
        <Stat label="Online" value={n.online !== undefined ? String(n.online) : "–"} />
      </dl>

      <section className="pblock" aria-labelledby="cast-title">
        <div className="block-head"><h2 id="cast-title">Cast</h2></div>
        {!d.livekit.configured ? (
          <div className="panel">
            <p>LiveKit metrics aren’t set up.</p>
            <p className="quiet">
              Add a <code>prometheus</code> section to <code>livekit.yaml</code> with a port, username and password, then set
              {" "}<code>LIVEKIT_METRICS_URL=http://user:password@host.docker.internal:6789/metrics</code> in the app’s <code>.env</code> and restart both.
            </p>
          </div>
        ) : (
          <>
            {d.livekit.error && <p className="inline-alert" role="alert"><TriangleAlert aria-hidden />{d.livekit.error}</p>}
            <div className="panel chart-panel">
              <TimeChart title="Bandwidth" {...c} format={bitrate} height={200}
                series={[{ key: "lkTx", label: "Upload", color: OUT }, { key: "lkRx", label: "Download", color: IN }]} />
              <p className="quiet chart-foot">
                Uploaded {sent("lkTx")} and downloaded {sent("lkRx")} in this range. Each viewer gets their own copy of a stream, so upload grows with the number of viewers.
              </p>
            </div>
            <div className="chart-grid">
              <TimeChart title="People connected" {...c} format={count} floor={2} series={one("lkPeople", "People")} />
              <TimeChart title="Packet loss" {...c} format={pct} floor={1} series={one("lkLoss", "Loss")} />
              <TimeChart title="Round trip" {...c} format={ms} floor={20} series={one("lkRtt", "Round trip")} />
              <TimeChart title="Jitter" {...c} format={ms} floor={5} series={one("lkJitter", "Jitter")} />
              <TimeChart title="Retransmitted" {...c} format={bitrate} floor={1000} series={one("lkRetx", "Retransmitted")} />
              <TimeChart title="LiveKit CPU" {...c} format={pct} floor={5} series={one("lkCpu", "CPU")} />
              <TimeChart title="LiveKit memory" {...c} format={memFmt} floor={64 * 2 ** 20} series={one("lkMem", "Memory")} />
            </div>
          </>
        )}
      </section>

      <section className="pblock" aria-labelledby="app-title">
        <div className="block-head"><h2 id="app-title">App</h2></div>
        <div className="panel chart-panel">
          <TimeChart title="Bandwidth" {...c} format={bitrate} height={200}
            series={[{ key: "tx", label: "Upload", color: OUT }, { key: "rx", label: "Download", color: IN }]} />
          <p className="quiet chart-foot">Uploaded {sent("tx")} and downloaded {sent("rx")} in this range. Includes the site, uploads, sounds, live updates and the Discord bot.</p>
        </div>
        <div className="chart-grid">
          <TimeChart title="CPU" {...c} format={pct} floor={5} series={one("cpu", "CPU")} />
          <TimeChart title="Memory" {...c} format={memFmt} floor={128 * 2 ** 20} series={one("mem", "Memory")} />
          <TimeChart title="Event loop delay" {...c} format={ms} floor={50} series={one("lag", "Delay")} />
          <TimeChart title="Requests" {...c} format={perMin} floor={1} series={one("req", "Requests")} />
          <TimeChart title="Response time" {...c} format={ms} floor={20} series={one("ms", "Response time")} />
          <TimeChart title="Server errors" {...c} format={perMin} floor={1 / 60} series={one("err", "Errors")} />
          <TimeChart title="Live connections" {...c} format={count} floor={2} series={one("sockets", "Connections")} />
          <TimeChart title="Discord ping" {...c} format={ms} floor={100} series={one("ping", "Ping")} />
        </div>
        <ByType d={d} />
      </section>

      <section className="pblock" aria-labelledby="storage-title">
        <div className="block-head"><h2 id="storage-title">Storage</h2></div>
        <div className="panel">
          <dl className="kv kv-grid">
            <div><dt>Database</dt><dd>{bytes(d.storage.db)}</dd></div>
            <div><dt>Uploads</dt><dd>{bytes(d.storage.uploads)}</dd></div>
            <div><dt>Sounds</dt><dd>{bytes(d.storage.sounds)}</dd></div>
            <div><dt>Free space</dt><dd>{d.storage.free === null ? "Unknown" : `${bytes(d.storage.free)} of ${bytes(d.storage.total ?? 0)}`}</dd></div>
          </dl>
        </div>
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd className="mono-num">{value}</dd>
    </div>
  );
}

/** What the app's upload was spent on over the range. */
function ByType({ d }: { d: MetricsResponse }) {
  const kinds: Array<[MetricKey, string]> = [["webB", "Site files"], ["apiB", "API"], ["uploadsB", "Uploads"], ["soundsB", "Sounds"], ["downloadsB", "Desktop app downloads"]];
  const rows = kinds.map(([k, label]) => ({ label, n: total(d.points, k, d.step) }));
  const counted = rows.reduce((s, r) => s + r.n, 0);
  rows.push({ label: "Other (live updates, Cast signalling, outside services)", n: Math.max(0, total(d.points, "tx", d.step) - counted) });
  rows.sort((a, b) => b.n - a.n);
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div className="panel">
      <h3 className="chart-title">Upload by type</h3>
      <ul className="bar-list">
        {rows.map((r) => (
          <li key={r.label}>
            <span>{r.label}</span>
            <span className="bar-track" aria-hidden><span style={{ width: `${(r.n / max) * 100}%` }} /></span>
            <span className="mono-num">{bytes(r.n)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface SystemInfo {
  version: string; node: string; startedAt: number; dbBytes: number;
  users: Record<string, number>; activeSessions: number; auditEntries: number; auditRetentionDays: number;
  youtube: { used: number; limit: number } | null;
}

const STATUS_WORD: Record<string, string> = { active: "active", pending: "waiting", suspended: "suspended", banned: "banned", left: "left" };

function ServerPanel() {
  const info = useLoad(() => api<SystemInfo>("GET", "/api/admin/system"));
  const d = info.data;
  return (
    <section className="pblock" aria-labelledby="sys-title">
      <div className="block-head"><h2 id="sys-title">Server</h2></div>
      {info.error ? <LoadError text={info.error} onRetry={info.reload} /> : !d ? <Loading rows={2} /> : (
        <div className="panel">
          {d.youtube ? <Quota used={d.youtube.used} limit={d.youtube.limit} /> : <p className="quiet">YouTube search is not configured.</p>}
          <dl className="kv kv-grid">
            <div><dt>Version</dt><dd className="mono-num">{d.version.slice(0, 7)}</dd></div>
            <div><dt>Running since</dt><dd>{ago(d.startedAt)}</dd></div>
            <div><dt>People</dt><dd>{Object.entries(d.users).map(([k, v]) => `${v} ${STATUS_WORD[k] ?? k}`).join(" · ") || "None"}</dd></div>
            <div><dt>Signed-in sessions</dt><dd>{d.activeSessions}</dd></div>
            <div><dt>Audit entries</dt><dd>{d.auditEntries.toLocaleString()} <span className="quiet">· kept {d.auditRetentionDays} days</span></dd></div>
            <div><dt>Node</dt><dd className="mono-num">{d.node}</dd></div>
          </dl>
          <div className="setting-row">
            <div className="setting-text">
              <span>Backup</span>
              <span className="quiet">A copy of the database: people, roles, settings and the audit log. You can also schedule snapshots of the <code>NAS/friends</code> dataset in TrueNAS (Data Protection → Periodic Snapshot Tasks).</span>
            </div>
            <div className="setting-control"><a className="btn btn-quiet btn-s" href="/api/admin/backup" download><Download aria-hidden />Download</a></div>
          </div>
        </div>
      )}
    </section>
  );
}

function Quota({ used, limit }: { used: number; limit: number }) {
  const left = Math.max(0, Math.floor((limit - used) / 101));
  const pct = Math.min(100, (used / limit) * 100);
  const level = pct >= 90 ? "is-high" : pct >= 70 ? "is-mid" : "";
  return (
    <div className="quota">
      <div className="quota-text">
        <span>YouTube searches today</span>
        <span className="quiet">About {left} left · {used.toLocaleString()} of {limit.toLocaleString()} units · resets at midnight Pacific</span>
      </div>
      <div className={`meter ${level}`} role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label="YouTube API quota used">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
