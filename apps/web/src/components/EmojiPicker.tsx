import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import dataSource from "emoji-picker-element-data/en/emojibase/data.json?url";

const GAP = 8;

/**
 * A searchable emoji picker (emoji-picker-element), loaded on first use, floating beside `anchor` in the top layer.
 * Emoji data is served from our own origin.
 */
export function EmojiPicker({ anchor, onPick, onClose, onClear }: {
  anchor: RefObject<HTMLElement | null>;
  onPick: (emoji: string) => void;
  onClose: () => void;
  /** Shown as a "No emoji" button under the picker when set. */
  onClear?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    let picker: HTMLElement | null = null;
    let gone = false;
    void import("emoji-picker-element").then(({ Picker }) => {
      if (gone || !mount.current) return;
      const p = new Picker({ dataSource });
      // Match the site's theme rather than the OS's (the site can be set to either).
      p.classList.add(getComputedStyle(document.documentElement).colorScheme.includes("light") ? "light" : "dark");
      p.addEventListener("emoji-click", (e) => {
        const unicode = e.detail.unicode;
        if (unicode) pick.current(unicode);
      });
      mount.current.append(p);
      picker = p;
      // Focus the search box so typing filters straight away.
      requestAnimationFrame(() => p.shadowRoot?.querySelector<HTMLInputElement>("input[type=search]")?.focus());
    });
    return () => {
      gone = true;
      picker?.remove();
    };
  }, []);

  // Float above the anchor when there's room, else below; keep it on screen.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    el.showPopover?.();
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      if (!a) return;
      const { width: w, height: h } = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const top = a.top - GAP - h >= GAP ? a.top - GAP - h : Math.min(a.bottom + GAP, vh - h - GAP);
      const left = Math.min(Math.max(a.left, GAP), vw - w - GAP);
      el.style.top = `${Math.max(top, GAP)}px`;
      el.style.left = `${Math.max(left, GAP)}px`;
    };
    place();
    const sized = new ResizeObserver(place);
    sized.observe(el);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    // A press outside the picker (and its button, which toggles it) closes just the picker.
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!el.contains(t) && !anchor.current?.contains(t)) close.current();
    };
    document.addEventListener("mousedown", outside);
    return () => {
      sized.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("mousedown", outside);
    };
  }, [anchor]);

  return (
    <div ref={host} className="emoji-pop" popover="manual" role="dialog" aria-label="Pick an emoji"
      onKeyDown={(e) => {
        // Escape closes the picker, not the panel around it.
        if (e.key === "Escape") {
          e.stopPropagation();
          close.current();
          anchor.current?.focus();
        }
      }}>
      <div ref={mount} className="emoji-pop-picker" />
      {onClear && <button type="button" className="btn btn-quiet btn-s" onClick={onClear}>No emoji</button>}
    </div>
  );
}
