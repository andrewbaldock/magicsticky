// Per-device settings: theme + relative font size (S/M/L). Persist in localStorage and apply to the
// document root (data-theme + a font-scale var) so CSS reacts. DEVICE prefs (not synced).
//
// THEME: default "light" = the look Andrew likes — dark desk/chrome + LIGHT pastel stickies (dark
// ink). "dark" inverts only the STICKY to a deep pastel + light ink; the desk stays dark either way.

import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";
export type FontSize = "s" | "m" | "l";

const THEME_KEY = "magicsticky.theme";
const FONT_KEY = "magicsticky.fontSize";
const FONT_SCALE: Record<FontSize, string> = { s: "0.9", m: "1", l: "1.15" };

function readTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light"; // default light (the liked look)
}
function readFont(): FontSize {
  const v = localStorage.getItem(FONT_KEY);
  return v === "s" || v === "l" ? v : "m"; // default medium
}

function apply(theme: Theme, font: FontSize) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.style.setProperty("--font-scale", FONT_SCALE[font]);
}

export function useSettings() {
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [fontSize, setFontState] = useState<FontSize>(readFont);

  // Apply on mount + whenever either changes.
  useEffect(() => {
    apply(theme, fontSize);
  }, [theme, fontSize]);

  const setTheme = useCallback((t: Theme) => {
    localStorage.setItem(THEME_KEY, t);
    setThemeState(t);
  }, []);
  const setFontSize = useCallback((f: FontSize) => {
    localStorage.setItem(FONT_KEY, f);
    setFontState(f);
  }, []);

  return { theme, setTheme, fontSize, setFontSize };
}
