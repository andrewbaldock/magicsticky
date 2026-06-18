import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { api } from "./api.ts";
import { Sheet } from "./Sheet.tsx";

// "Connect a Claude": generate (or rotate) this account's connector token. The raw token is shown
// ONCE — the server stores only its hash and won't return it again. Copy it, paste into Claude.
export function ConnectorSheet({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

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

  return (
    // Don't let a stray backdrop tap dismiss a freshly-revealed once-only token.
    <Sheet title="Connect a Claude" onClose={onClose} guardClose={() => token !== null}>
      {!token ? (
        <>
          <p className="muted">
            Generate a connector token, then add the Magic Sticky connector in Claude using it. Any
            Claude you connect can then read and update your shared sticky.
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
    </Sheet>
  );
}
