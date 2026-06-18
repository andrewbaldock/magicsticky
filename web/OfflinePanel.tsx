import { useState } from "react";
import { WifiOff, FileText, ListTodo, ArrowLeft } from "lucide-react";
import { useOffline, type CatchUpKind } from "./useOffline.ts";

// Shown when offline (or when there are still-pending catch-up notes). Leads with a choice — TEXT
// NOTE vs CLAUDE TODO — then a capture box per kind. Notes persist in localStorage and append to
// their target on reconnect (handled by useOffline). Both kinds can be in progress at once.
export function OfflinePanel() {
  const { online, pending, setNote } = useOffline();
  const [kind, setKind] = useState<CatchUpKind | null>(null);

  const hasPending = !!pending.text || !!pending.claude;
  // Only surface when offline, or when online but notes haven't finished shipping yet.
  if (online && !hasPending) return null;

  return (
    <div className="offline-bar" role="status">
      <div className="offline-head">
        <WifiOff size={16} />
        {online ? (
          <span>Back online — syncing your catch-up note{pending.text && pending.claude ? "s" : ""}…</span>
        ) : (
          <span>Offline — jot a catch-up note; it’ll sync when you reconnect.</span>
        )}
      </div>

      {!online &&
        (kind === null ? (
          <div className="offline-choice">
            <button className="big-choice" onClick={() => setKind("text")}>
              <FileText size={22} />
              <span>Text note</span>
              <small>adds to your notes</small>
            </button>
            <button className="big-choice" onClick={() => setKind("claude")}>
              <ListTodo size={22} />
              <span>Claude to-do</span>
              <small>adds to the shared prompt</small>
            </button>
          </div>
        ) : (
          <div className="offline-capture">
            <button className="offline-back" onClick={() => setKind(null)} aria-label="Back">
              <ArrowLeft size={16} />
              {kind === "text" ? "Text note" : "Claude to-do"}
            </button>
            <textarea
              className="offline-input"
              autoFocus
              value={pending[kind]?.text ?? ""}
              placeholder={kind === "text" ? "A quick note…" : "A to-do for Claude…"}
              onChange={(e) => setNote(kind, e.target.value)}
            />
            <small className="muted">
              Saved locally — appends below a “pwa catch-up” divider when you reconnect.
            </small>
          </div>
        ))}

      {/* When the choice screen is up, show what's already queued so it's not lost-feeling. */}
      {!online && kind === null && hasPending && (
        <div className="offline-queued muted">
          Queued: {pending.text ? "1 text note" : ""}
          {pending.text && pending.claude ? " + " : ""}
          {pending.claude ? "1 Claude to-do" : ""} — will sync on reconnect.
        </div>
      )}
    </div>
  );
}
