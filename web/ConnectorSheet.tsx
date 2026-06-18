import { useEffect, useRef, useState } from "react";
import { Copy, Check, X } from "lucide-react";
import { api } from "./api.ts";

// "Connect a Claude": generate (or rotate) this account's connector token. The raw token is shown
// ONCE — the server stores only its hash and won't return it again. Copy it, paste into Claude.
// Mobile-correct modal: locks background scroll, traps/restores focus, closes on Escape, and won't
// dismiss on a stray backdrop tap while a freshly-generated token is on screen.
export function ConnectorSheet({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const triggerWasFocused = useRef<Element | null>(null);

  // Lock body scroll while open (iOS-safe: position:fixed + restore scroll), move focus into the
  // sheet, close on Escape, and restore focus + scroll on unmount.
  useEffect(() => {
    triggerWasFocused.current = document.activeElement;
    const scrollY = window.scrollY;
    const body = document.body;
    const prev = { position: body.style.position, top: body.style.top, width: body.style.width };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";

    sheetRef.current?.querySelector<HTMLElement>("button")?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.width = prev.width;
      window.scrollTo(0, scrollY);
      (triggerWasFocused.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);

  const generate = async () => {
    setBusy(true);
    try {
      const { token } = await api.connectorToken();
      setToken(token);
      setCopied(false);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setCopied(true);
  };

  // A revealed token is shown only once — don't let a stray backdrop tap throw it away.
  const onBackdrop = () => {
    if (!token) onClose();
  };

  return (
    <div className="sheet-backdrop" onClick={onBackdrop}>
      <div
        className="sheet"
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Connect a Claude"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <h2 style={{ flex: 1 }}>Connect a Claude</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {!token ? (
          <>
            <p className="muted">
              Generate a connector token, then add the Magic Sticky connector in Claude using it.
              Any Claude you connect can then read and update your shared sticky.
            </p>
            <button className="btn" onClick={generate} disabled={busy}>
              {busy ? "Generating…" : "Generate token"}
            </button>
          </>
        ) : (
          <>
            <p className="muted">
              Copy this now — it’s shown only once. Generating again replaces it (the old one stops
              working).
            </p>
            <div className="token-box">
              <code>{token}</code>
              <button className="btn ghost" onClick={copy} aria-label="Copy token">
                {copied ? <Check size={18} /> : <Copy size={18} />}
              </button>
            </div>
            <button className="btn ghost" onClick={generate} disabled={busy}>
              Regenerate
            </button>
          </>
        )}
      </div>
    </div>
  );
}
