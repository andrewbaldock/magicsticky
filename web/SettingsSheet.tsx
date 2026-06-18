import { Sun, Moon, LogOut } from "lucide-react";
import { Sheet } from "./Sheet.tsx";
import { useSettings, type FontSize } from "./useSettings.tsx";

const FONT_LABELS: Array<{ key: FontSize; label: string }> = [
  { key: "s", label: "Small" },
  { key: "m", label: "Medium" },
  { key: "l", label: "Large" },
];

// Per-device settings: theme (dark/light) + relative font size, and sign-out. Opened from the gear.
export function SettingsSheet({ onClose, onLogout }: { onClose: () => void; onLogout: () => void }) {
  const { theme, setTheme, fontSize, setFontSize } = useSettings();

  return (
    <Sheet title="Settings" onClose={onClose}>
      <div className="settings-row">
        <span className="settings-label">Theme</span>
        {/* Sun/moon toggle (no words). Shows the CURRENT theme's icon; tap flips to the other. */}
        <button
          className="theme-toggle"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
        >
          {theme === "light" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>

      <div className="settings-row">
        <span className="settings-label">Text size</span>
        <div className="seg" role="group" aria-label="Text size">
          {FONT_LABELS.map((f) => (
            <button
              key={f.key}
              className={`seg-btn${fontSize === f.key ? " on" : ""}`}
              onClick={() => setFontSize(f.key)}
              aria-pressed={fontSize === f.key}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>Theme &amp; text size are saved on this device.</p>

      <button className="btn ghost settings-logout" onClick={onLogout}>
        <LogOut size={16} /> Sign out
      </button>
    </Sheet>
  );
}
