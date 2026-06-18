import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pin, Undo2, Link2, Settings } from "lucide-react";
import { api, ApiError, type StickyMeta, type StickyFull } from "./api.ts";
import { ConnectorSheet } from "./ConnectorSheet.tsx";
import { SettingsSheet } from "./SettingsSheet.tsx";
import { StickyEditor } from "./StickyEditor.tsx";
import { Daisy } from "./Daisy.tsx";
import { pastelFor } from "./palette.ts";
import { OfflinePanel } from "./OfflinePanel.tsx";
import { nextDelay, classifySaveError } from "./saveRetry.ts";
import { useSettings, type Theme } from "./useSettings.tsx";
import type { CSSProperties } from "react";

// Inline CSS vars for a sticky's per-note color (tab + pane). In dark mode the sticky inverts to a
// deep pastel with light ink; the desk/chrome stays dark either way.
function pastelVars(position: number, theme: Theme): CSSProperties {
  const p = pastelFor(position, theme);
  return {
    ["--sticky" as string]: p.fill,
    ["--sticky-edge" as string]: p.edge,
    ["--sticky-ink" as string]: p.ink,
    ["--sticky-ink-muted" as string]: p.inkMuted,
  };
}

const MAX_CHARS = 10_000;
const SAVE_DEBOUNCE_MS = 700;
// retry backoff/classification live in saveRetry.ts (unit-tested) — see nextDelay/classifySaveError.

type SaveState = "idle" | "saving" | "saved" | "conflict" | "error";
type PendingSave = { next: string; baseVersion: number; id: string };

export function Workspace({ onSignedOut }: { onSignedOut: () => void }) {
  const qc = useQueryClient();
  const { theme } = useSettings();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [current, setCurrent] = useState<StickyFull | null>(null);
  const [text, setText] = useState("");
  const [save, setSave] = useState<SaveState>("idle");
  const [showToken, setShowToken] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [staleNotice, setStaleNotice] = useState(false); // server changed while we were editing
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttempt = useRef(0); // # of consecutive failed save attempts → drives nextDelay()
  const pending = useRef<PendingSave | null>(null); // the latest unsaved edit (for retry/online flush)
  const dirty = useRef(false); // user has unsaved keystrokes → don't let a poll clobber them

  // 401 anywhere → sign out. Used by mutations/handlers below.
  const onError = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onSignedOut();
      else setSave("error");
    },
    [onSignedOut],
  );
  const guard = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        onError(e);
      }
    },
    [onError],
  );

  // --- READS via TanStack Query: poll for changes other clients (another Claude/device/tab) make ---

  // The stack of stickies (metadata + titles). Polls every 15s; refetches on window focus.
  const listQuery = useQuery({
    queryKey: ["stickies"],
    queryFn: () => api.listStickies().then((r) => r.stickies),
    refetchInterval: 15_000,
  });
  const metas: StickyMeta[] = listQuery.data ?? [];
  const refreshList = useCallback(() => qc.invalidateQueries({ queryKey: ["stickies"] }), [qc]);

  // On first load (or when the active one vanishes), open the shared sticky (or the first).
  useEffect(() => {
    if (metas.length === 0) return;
    if (activeId && metas.some((m) => m.id === activeId)) return;
    const open = metas.find((m) => m.is_shared) ?? metas[0];
    if (open) setActiveId(open.id);
  }, [metas, activeId]);

  // The active sticky's full text. Polls every 15s so an edit made elsewhere shows up here.
  const stickyQuery = useQuery({
    queryKey: ["sticky", activeId],
    queryFn: () => api.getSticky(activeId as string),
    enabled: !!activeId,
    refetchInterval: 15_000,
  });
  // Surface a query error (e.g. a 401 from polling → sign out) from an EFFECT, not the render body —
  // calling a state setter during render is a React anti-pattern and would re-fire every render.
  useEffect(() => {
    const err = stickyQuery.error ?? listQuery.error;
    if (err) onError(err);
  }, [stickyQuery.error, listQuery.error, onError]);

  // Adopt the server's version into the editor — but NEVER while the user is mid-edit (dirty), or
  // we'd clobber their keystrokes. If a newer version arrived while editing, show a quiet notice;
  // the next save's CAS reconciles. When not dirty, the polled text flows straight in.
  const serverSticky = stickyQuery.data;
  useEffect(() => {
    if (!serverSticky) return;
    // Nothing new vs what we already hold → don't churn (and don't stomp the save indicator).
    if (current && current.id === serverSticky.id && current.version === serverSticky.version) return;
    if (dirty.current) {
      // mid-edit: never clobber keystrokes; just flag that the server moved ahead.
      if (current && serverSticky.version > current.version) setStaleNotice(true);
      return;
    }
    // idle / different sticky → adopt the server's version. Does NOT touch `save` (the write path
    // owns that), so a freshly-saved "Saved" indicator isn't wiped by a poll.
    setCurrent(serverSticky);
    setText(serverSticky.text);
    setStaleNotice(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSticky?.id, serverSticky?.version, serverSticky?.text]);

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
        dirty.current = false; // saved → polling may adopt server state again
        setStaleNotice(false);
        setCurrent(updated);
        qc.setQueryData(["sticky", id], updated); // keep the query cache in sync (no clobber-back)
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
            qc.setQueryData(["sticky", id], latest);
            if (next !== latest.text) {
              setSave("conflict");
              queueSave(next, latest.version, id); // re-save our text on top of theirs
            } else {
              // our text already equals the server's → nothing to re-save. Clear dirty + mark saved
              // so polling-adoption resumes (otherwise dirty sticks and live-updates silently stop).
              pending.current = null;
              dirty.current = false;
              setStaleNotice(false);
              setSave("saved");
            }
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
    [refreshList, onSignedOut, qc],
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
    dirty.current = true; // hold off polling-adoption until this saves
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
        dirty.current = false; // undo overwrites local text from the server — safe to adopt polls
        setStaleNotice(false);
        setCurrent(restored);
        setText(restored.text);
        qc.setQueryData(["sticky", restored.id], restored);
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
            style={pastelVars(m.position, theme)}
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

      <main className="sticky-pane" style={activeMeta ? pastelVars(activeMeta.position, theme) : undefined}>
        <div className="sticky-head">
          {/* Brand mark, absolutely centered so it stays dead-center regardless of the lozenge
              width on the left or the button cluster on the right. */}
          <span className="head-brand" aria-hidden="true">
            <span className="head-brand__text">Magic</span>
            <Daisy size={22} />
            <span className="head-brand__text">Sticky</span>
          </span>
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
          {/* Connect a Claude only makes sense on the SHARED sticky — that's the note Claude reads. */}
          {current?.is_shared && (
            <button className="connect-btn" onClick={() => setShowToken(true)} aria-label="Connect a Claude">
              <Link2 size={16} />
              <span>Connect</span>
            </button>
          )}
          <button className="icon-btn" onClick={onUndo} aria-label="Undo last overwrite" title="Undo">
            <Undo2 size={20} />
          </button>
          <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Settings" title="Settings">
            <Settings size={20} />
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
          <span className={`save-state${save === "conflict" || save === "error" || staleNotice ? " conflict" : ""}`}>
            {staleNotice
              ? "Updated elsewhere — your changes will merge on save"
              : save === "saving"
                ? "Saving…"
                : save === "saved"
                  ? "Saved"
                  : save === "conflict"
                    ? "Merged a newer version — re-saving…"
                    : save === "error"
                      ? "Offline — your edits are queued, retrying…"
                      : ""}
          </span>
          {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
        </div>
      </main>

      {showToken && <ConnectorSheet onClose={() => setShowToken(false)} />}
      {showSettings && (
        <SettingsSheet
          onClose={() => setShowSettings(false)}
          onLogout={() => {
            setShowSettings(false);
            onLogout();
          }}
        />
      )}
    </div>
  );
}
