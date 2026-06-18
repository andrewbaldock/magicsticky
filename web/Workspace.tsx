import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Pin, Undo2, Link2, LogOut } from "lucide-react";
import { api, ApiError, type StickyMeta, type StickyFull } from "./api.ts";
import { ConnectorSheet } from "./ConnectorSheet.tsx";
import { StickyEditor } from "./StickyEditor.tsx";
import { pastelFor } from "./palette.ts";
import { OfflinePanel } from "./OfflinePanel.tsx";
import { nextDelay, classifySaveError } from "./saveRetry.ts";
import type { CSSProperties } from "react";

// Inline CSS vars for a sticky's pastel color (drives both its tab and, when active, the pane).
function pastelVars(position: number): CSSProperties {
  const p = pastelFor(position);
  return { ["--sticky" as string]: p.fill, ["--sticky-edge" as string]: p.edge };
}

const MAX_CHARS = 10_000;
const SAVE_DEBOUNCE_MS = 700;
// retry backoff/classification live in saveRetry.ts (unit-tested) — see nextDelay/classifySaveError.

type SaveState = "idle" | "saving" | "saved" | "conflict" | "error";
type PendingSave = { next: string; baseVersion: number; id: string };

export function Workspace({ onSignedOut }: { onSignedOut: () => void }) {
  const [metas, setMetas] = useState<StickyMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [current, setCurrent] = useState<StickyFull | null>(null);
  const [text, setText] = useState("");
  const [save, setSave] = useState<SaveState>("idle");
  const [showToken, setShowToken] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttempt = useRef(0); // # of consecutive failed save attempts → drives nextDelay()
  const pending = useRef<PendingSave | null>(null); // the latest unsaved edit (for retry/online flush)

  // Run an async action; on a 401 drop to signed-out, on any other error flag a save error rather
  // than letting the rejection vanish (every handler routes through this).
  const guard = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) onSignedOut();
        else setSave("error");
      }
    },
    [onSignedOut],
  );

  const refreshList = useCallback(async () => {
    const { stickies } = await api.listStickies();
    setMetas(stickies);
    return stickies;
  }, []);

  // Initial load: list, then open the shared one (or the first).
  useEffect(() => {
    guard(async () => {
      const stickies = await refreshList();
      const open = stickies.find((s) => s.is_shared) ?? stickies[0];
      if (open) setActiveId(open.id);
    });
  }, [guard, refreshList]);

  // Load full text whenever the active sticky changes.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    guard(async () => {
      const s = await api.getSticky(activeId);
      if (cancelled) return;
      setCurrent(s);
      setText(s.text);
      setSave("idle");
    });
    return () => {
      cancelled = true;
    };
  }, [activeId, guard]);

  // Debounced optimistic-CAS save with offline retry. A failed save (no connection / server blip)
  // does NOT give up — it keeps retrying with backoff until it lands, so edits typed offline sync
  // when the connection returns. 401 is the exception (auth, not connectivity → sign out).
  const performSave = useCallback(
    async (next: string, baseVersion: number, id: string) => {
      setSave("saving");
      try {
        const updated = await api.saveSticky(id, next, baseVersion);
        pending.current = null;
        retryAttempt.current = 0;
        setCurrent(updated);
        setSave("saved");
        refreshList(); // nav title (first line) may have changed
      } catch (e) {
        const outcome = classifySaveError(e);
        if (outcome === "signout") {
          onSignedOut(); // auth, not connectivity — don't retry
          return;
        }
        if (outcome === "conflict") {
          // someone else wrote since our base version; adopt theirs and re-save our text on top
          retryAttempt.current = 0;
          const latest = await api.getSticky(id).catch(() => null);
          if (latest) {
            setCurrent(latest);
            setSave("conflict");
            if (next !== latest.text) queueSave(next, latest.version, id);
          }
          return;
        }
        // network / server error → keep the edit queued and retry with backoff
        pending.current = { next, baseVersion, id };
        setSave("error");
        if (retryTimer.current) clearTimeout(retryTimer.current);
        const delay = nextDelay(retryAttempt.current);
        retryAttempt.current += 1;
        retryTimer.current = setTimeout(() => {
          const p = pending.current;
          if (p) void performSave(p.next, p.baseVersion, p.id);
        }, delay);
      }
    },
    [refreshList, onSignedOut],
  );

  // Debounce keystrokes, then perform (which owns retry). Stash the latest pending edit so a retry
  // or an "online" event always saves the freshest text.
  const queueSave = useCallback(
    (next: string, baseVersion: number, id: string) => {
      pending.current = { next, baseVersion, id };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const p = pending.current;
        if (p) void performSave(p.next, p.baseVersion, p.id);
      }, SAVE_DEBOUNCE_MS);
    },
    [performSave],
  );

  // When connectivity returns, immediately flush any pending edit instead of waiting out the backoff.
  useEffect(() => {
    const onOnline = () => {
      const p = pending.current;
      if (p) {
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryAttempt.current = 0; // connection's back — retry promptly, not at the backed-off delay
        void performSave(p.next, p.baseVersion, p.id);
      }
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [performSave]);

  const onChange = (v: string) => {
    setText(v);
    if (current) queueSave(v, current.version, current.id);
  };

  const onAdd = () =>
    guard(async () => {
      const { id } = await api.createSticky();
      await refreshList();
      setActiveId(id);
    });

  const onToggleShared = () =>
    guard(async () => {
      if (!current || current.is_shared) return; // already shared (set is one-way to a new target)
      await api.setShared(current.id);
      setCurrent({ ...current, is_shared: true });
      await refreshList();
    });

  const onUndo = () =>
    guard(async () => {
      const restored = await api.undo();
      if (restored.id === activeId) {
        setCurrent(restored);
        setText(restored.text);
        setSave("idle");
      }
      await refreshList();
    });

  const onLogout = () =>
    guard(async () => {
      await api.logout();
      onSignedOut();
    });

  const over = text.length > MAX_CHARS;
  const activeMeta = metas.find((m) => m.id === activeId);

  return (
    <div className="app">
      <OfflinePanel />
      <nav className="nav" aria-label="Your stickies">
        {metas.map((m) => (
          <button
            key={m.id}
            className={`tab${m.id === activeId ? " active" : ""}`}
            style={pastelVars(m.position)}
            onClick={() => setActiveId(m.id)}
          >
            {m.is_shared && <span className="shared-dot" aria-label="shared" />}
            <span className="tab-title">{m.title}</span>
          </button>
        ))}
        <button className="tab-add" onClick={onAdd} aria-label="New sticky" title="New sticky">
          <Plus size={20} />
        </button>
      </nav>

      <main className="sticky-pane" style={activeMeta ? pastelVars(activeMeta.position) : undefined}>
        <div className="sticky-head">
          <button
            className={`lozenge${current?.is_shared ? " is-shared" : ""}`}
            onClick={onToggleShared}
            disabled={!current || current.is_shared}
            title={current?.is_shared ? "This is the shared Claude prompt" : "Make this the shared prompt"}
          >
            <Pin size={13} />
            {current?.is_shared ? "Shared prompt" : "Make shared"}
          </button>
          <span className="head-spacer" />
          <button className="connect-btn" onClick={() => setShowToken(true)} aria-label="Connect a Claude">
            <Link2 size={16} />
            <span>Connect</span>
          </button>
          <button className="icon-btn" onClick={onUndo} aria-label="Undo last overwrite" title="Undo">
            <Undo2 size={20} />
          </button>
          <button className="icon-btn" onClick={onLogout} aria-label="Sign out" title="Sign out">
            <LogOut size={20} />
          </button>
        </div>

        {/* key on the sticky id so the editor remounts per sticky with the right initial mode
            (read if it has content, edit if empty). Render only once the active sticky's text has
            loaded, so it doesn't mount with an empty value and latch into edit mode. */}
        {current && current.id === activeId && (
          <StickyEditor
            key={current.id}
            value={text}
            onChange={onChange}
            placeholder="Write your sticky…"
          />
        )}

        <div className={`counter${over ? " over" : ""}`}>
          <span className={`save-state${save === "conflict" || save === "error" ? " conflict" : ""}`}>
            {save === "saving" && "Saving…"}
            {save === "saved" && "Saved"}
            {save === "conflict" && "Merged a newer version — re-saving…"}
            {save === "error" && "Offline — your edits are queued, retrying…"}
          </span>
          {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
        </div>
      </main>

      {showToken && <ConnectorSheet onClose={() => setShowToken(false)} />}
    </div>
  );
}
