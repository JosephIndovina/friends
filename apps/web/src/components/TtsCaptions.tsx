import { useSounds } from "../lib/sounds";
import { Avatar } from "./Avatar";

/** What's being said with text to speech, shown to everyone while it plays: who said it and the words. */
export function TtsCaptions() {
  const { captions } = useSounds();
  return (
    <div className="tts-captions" role="log" aria-live="polite" aria-label="Text to speech">
      {captions.map((c) => (
        <div key={c.key} className="tts-caption">
          <Avatar src={c.by.avatarUrl} name={c.by.name} size={28} />
          <p><strong>{c.by.name}</strong> {c.text}</p>
        </div>
      ))}
    </div>
  );
}
