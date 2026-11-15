import { useCallback, useEffect, useState } from "react";
import { Maximize, Pause, Play, SkipForward, Volume2 } from "lucide-react";
import { SEEKABLE, type Session } from "@friends/shared";
import { AddBox } from "../components/media/AddBox";
import { History, ModeToggle, Queue, Seek, Volume } from "../components/media/parts";
import { can } from "../lib/api";
import { useArtworkGlow } from "../lib/glow";
import { expectedPosition, KIND_LABEL, mediaAction, mediaError, useMediaState } from "../lib/media";
import { usePlayer } from "../lib/player";

export function Home({ session }: { session: Session }) {
  const state = useMediaState();
  const now = state?.now ?? null;
  const p = usePlayer();
  useArtworkGlow(now?.item.thumbnail);
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<HTMLDivElement | null>(null);
  const control = can(session, "player.control");
  const music = now?.item.mode === "music";

  const act = useCallback(async (pr: Promise<void>) => {
    setError(null);
    try {
      await pr;
    } catch (e) {
      setError(mediaError(e));
    }
  }, []);

  // Progress readout ticks while playing.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!now?.playing) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [now?.playing]);

  // Hand the persistent player our slot while we're mounted.
  const slotRef = useCallback((el: HTMLDivElement | null) => p.setSlot(el), [p.setSlot]);
  useEffect(() => () => p.setSlot(null), [p.setSlot]);
  useEffect(() => {
    if (now) p.setDismissedFor(null);
  }, [now?.item.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = now ? expectedPosition(now) : 0;

  return (
    <>
      <div className="room media-room">
        <section className="stage" aria-label="Player">
          <div ref={setScreen} className={`stage-screen player-screen${music ? " is-music" : ""}`}>
            {!now && (
              <div className="stage-idle">
                <h1>Nothing playing</h1>
                <p>Search YouTube or paste a YouTube or Twitch link.</p>
              </div>
            )}
            {now && music && (
              <div className="music-view">
                {now.item.thumbnail && <img className="music-backdrop" src={now.item.thumbnail} alt="" />}
                {now.item.thumbnail && <img className="music-art" src={now.item.thumbnail} alt="" />}
                <div className="music-text">
                  <h1 className="music-title">{now.item.title}</h1>
                  {now.item.author && <p className="music-artist">{now.item.author.replace(/ - Topic$/, "")}</p>}
                </div>
              </div>
            )}
            {now && <div ref={slotRef} className={music ? "player-slot player-slot-mini" : "player-slot"} />}
          </div>

          {now && (
            <>
              <div className="transport">
                <button className="icon-btn transport-main" disabled={!control}
                  aria-label={now.playing ? "Pause for everyone" : "Play for everyone"}
                  onClick={() => {
                    p.setAudible(true);
                    void act(now.playing ? mediaAction("media:pause", { position: pos }) : mediaAction("media:play"));
                  }}>
                  {now.playing ? <Pause aria-hidden /> : <Play aria-hidden />}
                </button>
                <button className="icon-btn" disabled={!control} aria-label="Skip" title="Skip" onClick={() => act(mediaAction("media:skip"))}><SkipForward aria-hidden /></button>
                {SEEKABLE[now.item.kind] ? (
                  <Seek position={pos} duration={now.item.duration} disabled={!control} onSeek={(s) => act(mediaAction("media:seek", { position: s }))} />
                ) : (
                  <span className="live-badge">{now.item.kind === "twitch-live" ? "Live" : "Clip"}</span>
                )}
                {p.audible
                  ? <Volume volume={p.volume} muted={false} onChange={p.setVolume} onToggle={() => p.setAudible(false)} />
                  : <button className="btn btn-primary btn-s sound-on" onClick={() => p.setAudible(true)}><Volume2 aria-hidden /><span className="sound-label">Turn on sound</span></button>}
                <button className="icon-btn" aria-label="Full screen" title="Full screen" onClick={() => screen?.requestFullscreen?.()}><Maximize aria-hidden /></button>
              </div>
              <div className="stage-info">
                <div className="now-meta">
                  {!music && <strong className="now-title">{now.item.title}</strong>}
                  <span>
                    {[now.item.author, KIND_LABEL[now.item.kind], `started by ${now.startedBy.name}`].filter(Boolean).join(" · ")}
                    {p.syncing && <span className="syncing"> · Syncing</span>}
                  </span>
                </div>
                {now.item.kind === "youtube" && <ModeToggle item={now.item} disabled={!control} />}
              </div>
            </>
          )}
        </section>

        <aside className="side">
          {error && <p className="flash flash-error" role="alert">{error}</p>}
          {can(session, "player.queue") && (
            <AddBox canPlayNext={control} onAdd={async (input) => {
              setError(null);
              try {
                await mediaAction("media:add", input);
                return true;
              } catch (e) {
                setError(mediaError(e));
                return false;
              }
            }} />
          )}
          <Queue session={session} items={state?.queue ?? []} act={act} />
          <History items={state?.history ?? []} canReplay={can(session, "player.queue")} onReplay={(id) => act(mediaAction("media:replay", { id }))} />
        </aside>
      </div>

      <section className="stream" aria-labelledby="stream-title">
        <h2 id="stream-title">Posts</h2>
        <p className="empty">No posts yet.</p>
      </section>
    </>
  );
}
