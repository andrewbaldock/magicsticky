import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Pin, Undo2, Link2, LogOut } from "lucide-react";
import { api, ApiError, type StickyMeta, type StickyFull } from "./api.ts";
import { ConnectorSheet } from "./ConnectorSheet.tsx";
import { StickyEditor } from "./StickyEditor.tsx";

const MAX_CHARS = 10_000;
const SAVE_DEBOUNCE_MS = 700;

type SaveState = "idle" | "saving" | "saved" | "conflict" | "error";

export function Workspace({ onSignedOut }: { onSignedOut: () => void }) {
  const [metas, setMetas] = useState<StickyMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [current, setCurrent] = useState<StickyFull | null>(null);
  const [text, setText] = useState("");
  const [save, setSave] = useState<SaveState>("idle");
  const [showToken, setShowToken] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Debounced optimistic-CAS save. On 409, adopt the latest version and RE-ARM a save so the user's
  // text actually persists (don't make them type another character to recover).
  const scheduleSave = useCallback(
    (next: string, baseVersion: number, id: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        guard(async () => {
          setSave("saving");
          try {
            const updated = await api.saveSticky(id, next, baseVersion);
            setCurrent(updated);
            setSave("saved");
            refreshList(); // nav title (first line) may have changed
          } catch (e) {
            if (e instanceof ApiError && e.status === 409) {
              // someone else wrote since our base version; adopt their version and retry our text
              const latest = await api.getSticky(id);
              setCurrent(latest);
              setSave("conflict");
              if (next !== latest.text) scheduleSave(next, latest.version, id);
            } else {
              throw e; // let guard handle 401 / flag error
            }
          }
        });
      }, SAVE_DEBOUNCE_MS);
    },
    [guard, refreshList],
  );

  const onChange = (v: string) => {
    setText(v);
    if (current) scheduleSave(v, current.version, current.id);
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

  return (
    <div className="app">
      <nav className="nav" aria-label="Your stickies">
        {metas.map((m) => (
          <button
            key={m.id}
            className={`tab${m.id === activeId ? " active" : ""}`}
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

      <main className="sticky-pane">
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
          <button className="icon-btn" onClick={() => setShowToken(true)} aria-label="Connect a Claude" title="Connect a Claude">
            <Link2 size={20} />
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
            {save === "error" && "Couldn’t save — check your connection"}
          </span>
          {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
        </div>
      </main>

      {showToken && <ConnectorSheet onClose={() => setShowToken(false)} />}
    </div>
  );
}
