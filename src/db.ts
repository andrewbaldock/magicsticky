// Magic Sticky — Phase 2 storage. SQLite on a Fly volume (bun:sqlite).
//
// The pivot model (SPEC v3): a sticky is ONE free-text blob (<= MAX_CHARS); the user holds a
// stack of ~10; exactly one is the "shared prompt" any Claude reads. No items/sections/status.
//
// Two invariants are load-bearing and live HERE in the store (not in a tool handler), so every
// write path — the MCP `write` tool AND the web-UI save — goes through the same code:
//   1. Optimistic concurrency: writeShared() is a compare-and-swap on `version`. The shared
//      sticky has two writers (human in browser, Claude via overwrite); a stale write is rejected
//      so neither clobbers the other.
//   2. list() returns METADATA ONLY — never the text of the non-shared stickies. That is the
//      privacy boundary that makes "only the shared one is readable by Claude" actually true.

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export const MAX_CHARS = 10_000; // per-sticky cap; UI shows a counter, store enforces it
// Soft stack cap. INTENTIONALLY enforced in the UI only (creating a sticky is a web action) — the
// store stays uncapped on count so a future "expand to 20" is a UI change, not a migration.
export const DEFAULT_STACK_SIZE = 10;

// Distinct error types so callers (MCP tool / HTTP API) can react differently.
export class VersionConflictError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`version conflict: you have ${expected}, current is ${actual}. Re-read and retry.`);
    this.name = "VersionConflictError";
  }
}
export class TooLongError extends Error {
  constructor(public readonly length: number) {
    super(`text is ${length} chars; the limit is ${MAX_CHARS}. Trim it and retry.`);
    this.name = "TooLongError";
  }
}
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

export interface Sticky {
  id: string;
  user_id: string;
  text: string;
  prev_text: string | null;
  char_count: number;
  is_shared: boolean;
  position: number;
  version: number;
  created_at: string;
  updated_at: string;
}

// What list() exposes — deliberately NO `text` (privacy boundary).
export interface StickyMeta {
  id: string;
  position: number;
  char_count: number;
  is_shared: boolean;
}

interface Row {
  id: string;
  user_id: string;
  text: string;
  prev_text: string | null;
  char_count: number;
  is_shared: number;
  position: number;
  version: number;
  created_at: string;
  updated_at: string;
}

function rowToSticky(r: Row): Sticky {
  return { ...r, is_shared: r.is_shared === 1 };
}

export class Store {
  private db: Database;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sticky (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        text        TEXT NOT NULL DEFAULT '',
        prev_text   TEXT,
        -- char_count is the PLAINTEXT length, written at write-time. It exists as its own column
        -- (not LENGTH of the text column) so that when step 4 encrypts text at rest, the UI
        -- counter, the cap logic, and list() keep working on real char counts, not ciphertext len.
        char_count  INTEGER NOT NULL DEFAULT 0,
        is_shared   INTEGER NOT NULL DEFAULT 0,
        position    INTEGER NOT NULL,
        version     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      -- at most one shared sticky per user
      CREATE UNIQUE INDEX IF NOT EXISTS one_shared_per_user
        ON sticky(user_id) WHERE is_shared = 1;
      CREATE INDEX IF NOT EXISTS sticky_user_pos ON sticky(user_id, position);
    `);
  }

  close(): void {
    this.db.close();
  }

  private now(): string {
    return new Date().toISOString();
  }

  // Create a sticky for a user at the next free position. If `shared`, it becomes THE shared one
  // (clearing any prior shared in the same transaction so the unique index never trips).
  create(userId: string, text = "", opts: { shared?: boolean } = {}): Sticky {
    if (text.length > MAX_CHARS) throw new TooLongError(text.length);
    const id = randomUUID();
    const ts = this.now();
    const tx = this.db.transaction(() => {
      const { n } = this.db
        .query<{ n: number }, [string]>(
          "SELECT COALESCE(MAX(position), -1) + 1 AS n FROM sticky WHERE user_id = ?",
        )
        .get(userId)!;
      if (opts.shared) {
        this.db.run("UPDATE sticky SET is_shared = 0 WHERE user_id = ? AND is_shared = 1", [userId]);
      }
      this.db.run(
        `INSERT INTO sticky (id, user_id, text, prev_text, char_count, is_shared, position, version, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?, ?)`,
        [id, userId, text, text.length, opts.shared ? 1 : 0, n, ts, ts],
      );
    });
    tx();
    return this.get(userId, id)!;
  }

  get(userId: string, id: string): Sticky | null {
    const r = this.db
      .query<Row, [string, string]>("SELECT * FROM sticky WHERE user_id = ? AND id = ?")
      .get(userId, id);
    return r ? rowToSticky(r) : null;
  }

  // METADATA ONLY — no `text`. The privacy boundary; do not add text here. char_count is the
  // stored plaintext-length column (NOT LENGTH(text)), so it stays correct once text is encrypted.
  list(userId: string): StickyMeta[] {
    return this.db
      .query<{ id: string; position: number; char_count: number; is_shared: number }, [string]>(
        `SELECT id, position, char_count, is_shared
         FROM sticky WHERE user_id = ? ORDER BY position`,
      )
      .all(userId)
      .map((r) => ({
        id: r.id,
        position: r.position,
        char_count: r.char_count,
        is_shared: r.is_shared === 1,
      }));
  }

  getShared(userId: string): Sticky | null {
    const r = this.db
      .query<Row, [string]>("SELECT * FROM sticky WHERE user_id = ? AND is_shared = 1")
      .get(userId);
    return r ? rowToSticky(r) : null;
  }

  // The ONE compare-and-swap every write path uses. Rejects on stale version or over-cap; stashes
  // the overwritten text into prev_text (1-deep undo); bumps version. Returns the updated sticky.
  writeShared(userId: string, id: string, text: string, expectedVersion: number): Sticky {
    if (text.length > MAX_CHARS) throw new TooLongError(text.length);
    const tx = this.db.transaction(() => {
      const current = this.get(userId, id);
      if (!current) throw new NotFoundError(`sticky ${id}`);
      if (current.version !== expectedVersion) {
        throw new VersionConflictError(expectedVersion, current.version);
      }
      this.db.run(
        `UPDATE sticky
         SET prev_text = text, text = ?, char_count = ?, version = version + 1, updated_at = ?
         WHERE user_id = ? AND id = ?`,
        [text, text.length, this.now(), userId, id],
      );
    });
    tx();
    return this.get(userId, id)!;
  }

  // Flip which sticky is shared. LWW on a single flag; clears the prior shared in one transaction.
  setShared(userId: string, id: string): Sticky {
    const tx = this.db.transaction(() => {
      const target = this.get(userId, id);
      if (!target) throw new NotFoundError(`sticky ${id}`);
      this.db.run("UPDATE sticky SET is_shared = 0 WHERE user_id = ? AND is_shared = 1", [userId]);
      this.db.run("UPDATE sticky SET is_shared = 1, updated_at = ? WHERE user_id = ? AND id = ?", [
        this.now(),
        userId,
        id,
      ]);
    });
    tx();
    return this.get(userId, id)!;
  }

  // 1-deep undo: swap text <-> prev_text on the shared sticky. Bumps version (it's a write).
  // Returns null if there is nothing to undo.
  undoShared(userId: string): Sticky | null {
    const tx = this.db.transaction((): boolean => {
      const s = this.getShared(userId);
      if (!s || s.prev_text === null) return false;
      // swap text <-> prev_text; char_count follows the now-current text (prev_text is non-null here)
      this.db.run(
        `UPDATE sticky
         SET text = prev_text, prev_text = text, char_count = ?, version = version + 1, updated_at = ?
         WHERE user_id = ? AND id = ?`,
        [s.prev_text!.length, this.now(), userId, s.id],
      );
      return true;
    });
    return tx() ? this.getShared(userId) : null;
  }
}
