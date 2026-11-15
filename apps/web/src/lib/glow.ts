import { useEffect, useState } from "react";
import { artworkColor } from "./color";

/**
 * The room takes the colour of whatever is on. Pass the current artwork's colour, or null when idle,
 * and the whole page crossfades (the transition lives on `html` in app.css).
 * Colours are clamped in OKLCH so text over the wash keeps its contrast.
 */
export function useGlow(color: string | null) {
  useEffect(() => {
    const root = document.documentElement;
    if (!color) {
      root.style.setProperty("--glow", "var(--glow-idle)");
      return;
    }
    root.style.setProperty("--glow", `oklch(from ${color} clamp(0.45, l, 0.72) clamp(0.04, c, 0.16) h)`);
  }, [color]);
}

/** Glow from an artwork URL (null/undefined = idle). */
export function useArtworkGlow(url: string | null | undefined) {
  const [color, setColor] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void artworkColor(url).then((c) => live && setColor(c));
    return () => {
      live = false;
    };
  }, [url]);
  useGlow(url ? color : null);
}
