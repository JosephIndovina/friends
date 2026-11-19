import { useEffect, useRef, useState } from "react";
import { AudioLines } from "lucide-react";
import type { Activity, Me } from "@friends/shared";
import { usePresence } from "../lib/presence";
import { useSounds } from "../lib/sounds";

const LABEL: Record<Activity, string> = { watching: "Watching", listening: "Listening", casting: "Casting", idle: "Online" };
const ORDER: Activity[] = ["casting", "watching", "listening", "idle"];
const SHOWN = 5;

/** Who's here, on every page: an avatar stack ringed by what each person is doing; opens the full list. */
export function PresenceStack({ me }: { me: Me }) {
  const people = usePresence()
    .filter((p) => p.id !== me.id)
    .toSorted((a, b) => ORDER.indexOf(a.activity) - ORDER.indexOf(b.activity) || a.name.localeCompare(b.name));
  const { recent } = useSounds();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const summary = people.length === 0 ? "No one else here" : `${people.length} here`;
  return (
    <div className="presence-stack" ref={root}>
      <button className="stack-btn" aria-expanded={open} aria-label={`${summary}. Show who’s here`} onClick={() => setOpen(!open)}>
        {people.length === 0 ? <span className="stack-empty">Only you</span> : (
          <>
            <span className="stack-faces">
              {people.slice(0, SHOWN).map((p) => {
                const played = recent.get(p.id);
                return (
                  <span key={p.id} className={`stack-slot slot-${p.activity}`}>
                    <img src={p.avatarUrl} alt="" className={`stack-face ring-${p.activity}`} width={30} height={30} />
                    {/* What they just played on the soundboard; keyed so a repeat press pops again. */}
                    {played && <span key={played.key} className="stack-sound" title={`${p.name} played ${played.sound.name}`}>{played.sound.emoji ?? <AudioLines aria-hidden />}</span>}
                  </span>
                );
              })}
            </span>
            {people.length > SHOWN && <span className="stack-more">+{people.length - SHOWN}</span>}
          </>
        )}
      </button>
      {open && (
        <div className="stack-panel" role="dialog" aria-label="Who’s here">
          <h2>Here now <span className="quiet">{people.length + 1}</span></h2>
          <ul>
            {people.map((p) => (
              <li key={p.id}>
                <img src={p.avatarUrl} alt="" className={`stack-face ring-${p.activity}`} width={32} height={32} />
                <span className="who"><span>{p.name}</span><span className={`where act-${p.activity}`}>{LABEL[p.activity]}</span></span>
              </li>
            ))}
            <li>
              <img src={me.avatarUrl} alt="" className="stack-face" width={32} height={32} />
              <span className="who"><span>{me.name} <span className="quiet">(you)</span></span></span>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
