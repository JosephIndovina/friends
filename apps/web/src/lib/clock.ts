import { getSocket } from "./socket";

/** Estimated (serverNow - localNow) in ms. Uses the lowest-latency of several pings. */
let offset = 0;
let synced = false;

function ping(): Promise<{ offset: number; rtt: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    getSocket().emit("time:ping", (server: number) => {
      const t1 = Date.now();
      resolve({ offset: server - (t0 + t1) / 2, rtt: t1 - t0 });
    });
  });
}

export async function syncClock(samples = 6) {
  const results: { offset: number; rtt: number }[] = [];
  for (let i = 0; i < samples; i++) results.push(await ping());
  results.sort((a, b) => a.rtt - b.rtt);
  offset = results[0]!.offset;
  synced = true;
}

export const serverNow = () => Date.now() + offset;
export const isClockSynced = () => synced;

// Resync on (re)connect and every few minutes; clocks drift and networks change.
const s = getSocket();
s.on("connect", () => void syncClock());
setInterval(() => s.connected && void syncClock(3), 5 * 60 * 1000);
