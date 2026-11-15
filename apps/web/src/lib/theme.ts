import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "dark" | "light";

function read(): ThemeChoice {
  try {
    const t = localStorage.getItem("theme");
    return t === "dark" || t === "light" ? t : "system";
  } catch {
    return "system";
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<ThemeChoice>(read);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", theme);
    } catch {
      /* storage unavailable: the choice lasts for this visit */
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute("content", getComputedStyle(root).getPropertyValue("--ground").trim() || "#0a0c11");
  }, [theme]);
  return [theme, setTheme] as const;
}
