// Per-device settings (theme + relative font size), shared across the app via context so a change
// in the Settings sheet re-renders everything that depends on it (notably Workspace, which colors
// the stickies by theme). DEVICE prefs — persisted in localStorage, not synced.
//
// THEME: default "light" = the look Andrew likes — dark desk/chrome + LIGHT pastel stickies (dark
// ink). "dark" inverts only the STICKY to a deep pastel + light ink; the desk stays dark either way.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

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
  return v === "s" || v === "l" ? v : "m";
}
function apply(theme: Theme, font: FontSize) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.style.setProperty("--font-scale", FONT_SCALE[font]);
}

interface SettingsCtx {
  theme: Theme;
  setTheme: (t: Theme) => void;
  fontSize: FontSize;
  setFontSize: (f: FontSize) => void;
}

const Ctx = createContext<SettingsCtx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [fontSize, setFontState] = useState<FontSize>(readFont);

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

  return <Ctx.Provider value={{ theme, setTheme, fontSize, setFontSize }}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSettings must be used within <SettingsProvider>");
  return v;
}
