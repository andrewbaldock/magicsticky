// Offline catch-up state. Tracks online/offline, holds two in-progress catch-up notes (a TEXT note
// and a CLAUDE todo) persisted in localStorage so they survive a refresh/close while offline, and
// flushes them (append-only, below a timestamped divider) when the connection returns.
//
// Each note always reflects the user's latest edit until it ships; on reconnect each is appended to
// its target and cleared. Stamp is captured at WRITE time (first edit), per the divider format.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";

export type CatchUpKind = "text" | "claude";

interface PendingNote {
  text: string;
  stamp: string; // captured at first write, e.g. "3.16.2025 10:06am"
}
type Pending = Partial<Record<CatchUpKind, PendingNote>>;

const LS_KEY = "magicsticky.catchup";

// "3.16.2025 10:06am" — M.D.YYYY h:mma.
function stampNow(): string {
  const d = new Date();
  let h = d.getHours();
  const am = h < 12 ? "am" : "pm";
  h = h % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}.${d.getDate()}.${d.getFullYear()} ${h}:${min}${am}`;
}

function load(): Pending {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as Pending;
  } catch {
    return {};
  }
}
function save(p: Pending) {
  localStorage.setItem(LS_KEY, JSON.stringify(p));
}

export function useOffline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [pending, setPending] = useState<Pending>(load);
  const flushing = useRef(false);

  // Edit (or start) a catch-up note. Empty text clears it.
  const setNote = useCallback((kind: CatchUpKind, text: string) => {
    setPending((prev) => {
      const next: Pending = { ...prev };
      if (text.trim() === "") {
        delete next[kind];
      } else {
        next[kind] = { text, stamp: prev[kind]?.stamp ?? stampNow() }; // keep the original stamp
      }
      save(next);
      return next;
    });
  }, []);

  // Ship any pending notes (called on reconnect). Each appends to its target; cleared on success,
  // kept on failure to retry next time.
  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      const cur = load();
      for (const kind of ["text", "claude"] as CatchUpKind[]) {
        const note = cur[kind];
        if (!note) continue;
        try {
          await api.catchUp(kind, note.text, note.stamp);
          setPending((prev) => {
            const next = { ...prev };
            delete next[kind];
            save(next);
            return next;
          });
        } catch {
          /* leave it queued; a later reconnect/flush retries */
        }
      }
    } finally {
      flushing.current = false;
    }
  }, []);

  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      void flush();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    // If we loaded online with leftover pending notes (e.g. closed the tab before reconnect), flush.
    if (navigator.onLine) void flush();
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [flush]);

  return { online, pending, setNote };
}
