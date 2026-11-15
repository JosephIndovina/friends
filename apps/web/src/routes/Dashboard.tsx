import { Link } from "@tanstack/react-router";
import { Clapperboard, MonitorUp, Music2, Play } from "lucide-react";
import type { Me } from "@friends/shared";
import { Avatar } from "../components/Avatar";
import { useArtworkGlow } from "../lib/glow";
import { expectedPosition, fmtTime, KIND_LABEL, useMediaState } from "../lib/media";
import { usePresence, whereLabel } from "../lib/presence";

export function Dashboard({ me }: { me: Me }) {
  const media = useMediaState();
  const now = media?.now ?? null;
  useArtworkGlow(now?.item.thumbnail);
  const people = usePresence();
  const watching = people.filter((p) => p.section === "media").length;

  return (
    <>
      <div className="room">
        <section className="stage" aria-labelledby="stage-title">
          {now ? (
            <Link to="/media" className="stage-screen stage-art" aria-label={`Watch ${now.item.title}`}>
              {now.item.thumbnail && <img src={now.item.thumbnail} alt="" />}
              <span className="stage-play"><Play aria-hidden /></span>
            </Link>
          ) : (
            <div className="stage-screen">
              <div className="stage-idle">
                <h1 id="stage-title">Nothing playing</h1>
                <div className="stage-actions">
                  <Link to="/music" className="btn btn-primary"><Music2 aria-hidden />Music</Link>
                  <Link to="/media" className="btn btn-quiet"><Clapperboard aria-hidden />Media</Link>
                  <Link to="/cast" className="btn btn-quiet"><MonitorUp aria-hidden />Cast</Link>
                </div>
              </div>
            </div>
          )}
          {now && (
            <div className="stage-info">
              <div className="now-meta">
                <h1 id="stage-title" className="now-title">{now.item.title}</h1>
                <span>
                  {[KIND_LABEL[now.item.kind], now.playing ? null : "Paused", now.item.kind === "twitch-live" ? "Live" : `${fmtTime(expectedPosition(now))} / ${fmtTime(now.item.duration)}`, `${watching} watching`].filter(Boolean).join(" · ")}
                </span>
              </div>
              <Link to="/media" className="btn btn-primary"><Play aria-hidden />Watch</Link>
            </div>
          )}
        </section>

        <aside className="side">
          <div className="block">
            <h2>Online {people.length > 0 && <span className="quiet">{people.length}</span>}</h2>
            <ul className="presence">
              {people
                .toSorted((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : a.name.localeCompare(b.name)))
                .map((p) => (
                  <li key={p.id}>
                    <Avatar src={p.avatarUrl} name={p.name} size={36} />
                    <span className="who">
                      <span>{p.name}{p.id === me.id && <span className="you"> (you)</span>}</span>
                      <span className="where">{whereLabel[p.section]}</span>
                    </span>
                  </li>
                ))}
            </ul>
          </div>
          {media && media.queue.length > 0 && (
            <div className="block">
              <h2>Up next in Media</h2>
              <ol className="mini-queue">
                {media.queue.slice(0, 3).map((q) => <li key={q.id}>{q.title}</li>)}
              </ol>
            </div>
          )}
        </aside>
      </div>

      <section className="stream" aria-labelledby="stream-title">
        <h2 id="stream-title">Posts</h2>
        <p className="empty">No posts yet.</p>
      </section>
    </>
  );
}
