import { Link } from "@tanstack/react-router";
import { Clapperboard, MonitorUp, Music2 } from "lucide-react";
import type { Me } from "@friends/shared";
import { Avatar } from "../components/Avatar";
import { useGlow } from "../lib/glow";
import { usePresence, whereLabel } from "../lib/presence";

export function Dashboard({ me }: { me: Me }) {
  // Nothing plays until Phase 1/2 land, so the room sits at its idle ember.
  useGlow(null);
  const people = usePresence();
  const others = people.filter((p) => p.id !== me.id).length;

  return (
    <>
      <div className="room">
        <section className="stage" aria-labelledby="stage-title">
          <div className="stage-screen">
            <div className="stage-idle">
              <h1 id="stage-title">Nothing’s on</h1>
              <p>Start something and everyone here can join in, in sync.</p>
              <div className="stage-actions">
                <Link to="/music" className="btn btn-primary"><Music2 aria-hidden />Start music</Link>
                <Link to="/media" className="btn btn-quiet"><Clapperboard aria-hidden />Watch something</Link>
                <Link to="/cast" className="btn btn-quiet"><MonitorUp aria-hidden />Go live</Link>
              </div>
            </div>
          </div>
          <div className="stage-info">
            <span>
              {others === 0 ? "Just you on the couch right now" : <><strong>{others} {others === 1 ? "friend" : "friends"}</strong> on the couch with you</>}
            </span>
          </div>
        </section>

        <aside className="side">
          <div className="block">
            <h2>On the couch</h2>
            {people.length === 0 ? (
              <p className="block-note">Connecting…</p>
            ) : (
              <ul className="couch">
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
            )}
          </div>
        </aside>
      </div>

      <section className="stream" aria-labelledby="stream-title">
        <h2 id="stream-title">The stream</h2>
        <p className="empty">Messages, screenshots and clips the group shares will land here. Posting arrives in an upcoming update.</p>
      </section>
    </>
  );
}
