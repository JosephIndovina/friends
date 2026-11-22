import { useEffect, useRef } from "react";
import dataSource from "emoji-picker-element-data/en/emojibase/data.json?url";

/** A searchable emoji picker (emoji-picker-element), loaded on first use. Emoji data is served from our own origin. */
export function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    let picker: HTMLElement | null = null;
    let gone = false;
    void import("emoji-picker-element").then(({ Picker }) => {
      if (gone || !host.current) return;
      const p = new Picker({ dataSource });
      // Match the site's theme rather than the OS's (the site can be set to either).
      p.classList.add(getComputedStyle(document.documentElement).colorScheme.includes("light") ? "light" : "dark");
      p.addEventListener("emoji-click", (e) => {
        const unicode = e.detail.unicode;
        if (unicode) pick.current(unicode);
      });
      host.current.append(p);
      picker = p;
      // Focus the search box so typing filters straight away.
      requestAnimationFrame(() => p.shadowRoot?.querySelector<HTMLInputElement>("input[type=search]")?.focus());
    });
    return () => {
      gone = true;
      picker?.remove();
    };
  }, []);

  return (
    <div ref={host} className="emoji-picker"
      onKeyDown={(e) => {
        // Escape closes the picker, not the panel around it.
        if (e.key === "Escape") {
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
          onClose();
        }
      }} />
  );
}
