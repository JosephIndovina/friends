import { useEffect, useRef, useState } from "react";
import { Speech } from "lucide-react";
import { TTS_LIMITS, TTS_VOICES } from "@friends/shared";
import { soundError, useSounds } from "../../lib/sounds";

/**
 * Text to speech: a button in the stage bar, next to the soundboard. The server makes one clip in the
 * speaker's voice and everyone on the site plays that same clip, through the soundboard's volume.
 */
export function Speak() {
  const { canSpeak, speak, voice, setVoice } = useSounds();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setError(null);
      return;
    }
    input.current?.focus();
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

  if (!canSpeak) return null;
  const left = TTS_LIMITS.chars - [...text].length;

  return (
    <div className="tts-pop" ref={root}>
      <button className="icon-btn" aria-label="Text to speech" aria-expanded={open} data-tip={open ? undefined : "Text to speech"} onClick={() => setOpen(!open)}>
        <Speech aria-hidden />
      </button>
      {open && (
        <div className="stack-panel sound-panel" role="dialog" aria-label="Text to speech">
          <div className="sound-head"><h2>Text to speech</h2></div>
          {/* Stays open after sending, so the next line can follow straight away. */}
          <form className="tts-form" onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim() || busy) return;
            setBusy(true);
            setError(null);
            try {
              await speak(text.trim());
              setText("");
            } catch (err) {
              setError(soundError(err));
            } finally {
              setBusy(false);
              input.current?.focus();
            }
          }}>
            <label className="field">
              <span>Message</span>
              <input ref={input} className="input" value={text} maxLength={TTS_LIMITS.chars} onChange={(e) => setText(e.target.value)} aria-describedby="tts-left" />
            </label>
            <div className="tts-row">
              <select className="input" value={voice} onChange={(e) => setVoice(e.target.value)} aria-label="Voice">
                {[...new Set(TTS_VOICES.map((v) => v.accent))].map((accent) => (
                  <optgroup key={accent} label={accent}>
                    {TTS_VOICES.filter((v) => v.accent === accent).map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                  </optgroup>
                ))}
              </select>
              <button className="btn btn-primary btn-s" disabled={!text.trim() || busy}>{busy ? "Saying…" : "Say"}</button>
            </div>
            <p id="tts-left" className="quiet sound-limits" aria-live="polite">
              {left <= 40 ? `${left} characters left. ` : ""}Everyone on the site hears it in this voice.
            </p>
            {error && <p className="field-error" role="alert">{error}</p>}
          </form>
        </div>
      )}
    </div>
  );
}
