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
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { Cipher } from "./crypto.ts";

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

export interface Account {
  user_id: string;
  google_sub: string;
  email: string | null;
  onboarded: boolean;
  created_at: string;
  updated_at: string;
}

interface AccountRow {
  user_id: string;
  google_sub: string;
  email: string | null;
  onboarded: number;
  created_at: string;
  updated_at: string;
}

function accountRowToAccount(r: AccountRow): Account {
  return { ...r, onboarded: r.onboarded === 1 };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// The onboarding blurb appended to sticky 1 on first signup. Plain text (a sticky is not rich
// text). Deletable by the user; never re-injected (guarded by account.onboarded).
export const ONBOARDING_BLURB =
  "👋 This is your shared prompt — the note every Claude you talk to can read.\n" +
  "Install the Magic Sticky connector in Claude, then just say \"check my sticky\" to start.\n" +
  "Edit or delete this freely — it's your note.";

interface Row {
  id: string;
  user_id: string;
  text: string;
  prev_text: string | null;
  char_count: number;
  key_id: string | null;
  is_shared: number;
  position: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export class Store {
  private db: Database;
  private cipher: Cipher | null;

  // Pass a Cipher to encrypt `text`/`prev_text` at rest (SPEC §11). Omit (dev/test) → plaintext.
  constructor(path = ":memory:", cipher: Cipher | null = null) {
    this.db = new Database(path);
    this.cipher = cipher;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  // --- encryption boundary: stored form <-> plaintext. Everything above this deals in plaintext. ---

  // Encrypt a value for storage; returns the stored string + the key_id it's under (null if no
  // cipher). The owning user_id is bound as AAD so a blob only decrypts in its owner's context.
  // Both text and prev_text in a row share the same key_id (the current primary key).
  private encOut(plaintext: string, userId: string): { stored: string; keyId: string | null } {
    if (!this.cipher) return { stored: plaintext, keyId: null };
    const { ciphertext, keyId } = this.cipher.encrypt(plaintext, userId);
    return { stored: ciphertext, keyId };
  }

  private decIn(stored: string | null, keyId: string | null, userId: string): string | null {
    if (stored === null) return null;
    if (keyId === null || !this.cipher) return stored; // stored plaintext
    return this.cipher.decrypt(stored, keyId, userId);
  }

  // Map a stored row to a plaintext Sticky (decrypting text/prev_text; key_id stays internal).
  private rowToSticky(r: Row): Sticky {
    return {
      id: r.id,
      user_id: r.user_id,
      text: this.decIn(r.text, r.key_id, r.user_id) ?? "",
      prev_text: this.decIn(r.prev_text, r.key_id, r.user_id),
      char_count: r.char_count,
      is_shared: r.is_shared === 1,
      position: r.position,
      version: r.version,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
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
        -- key_id names which encryption key text/prev_text are under (NULL = stored plaintext,
        -- e.g. dev/no-cipher). Enables lazy key rotation: rewrite under the new key on next write.
        key_id      TEXT,
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

      -- one row per signed-in human. google_sub is the stable Google account id (the OIDC 'sub').
      -- onboarded marks that sticky 1 was seeded once, so re-auth never re-injects the blurb.
      CREATE TABLE IF NOT EXISTS account (
        user_id              TEXT PRIMARY KEY,
        google_sub           TEXT NOT NULL UNIQUE,
        email                TEXT,
        onboarded            INTEGER NOT NULL DEFAULT 0,
        -- sha256(raw connector token) for the user's OWN Claude. We store only the hash, never the
        -- raw token. NULL until they generate one. Rotating = overwrite (the old token stops working).
        connector_token_hash TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS account_connector_token
        ON account(connector_token_hash) WHERE connector_token_hash IS NOT NULL;
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
      const { stored, keyId } = this.encOut(text, userId);
      this.db.run(
        `INSERT INTO sticky (id, user_id, text, prev_text, char_count, key_id, is_shared, position, version, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, ?)`,
        [id, userId, stored, text.length, keyId, opts.shared ? 1 : 0, n, ts, ts],
      );
    });
    tx();
    return this.get(userId, id)!;
  }

  get(userId: string, id: string): Sticky | null {
    const r = this.db
      .query<Row, [string, string]>("SELECT * FROM sticky WHERE user_id = ? AND id = ?")
      .get(userId, id);
    return r ? this.rowToSticky(r) : null;
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

  // HUMAN-ONLY list: metadata + a derived title (first line / first ~30 chars). This DECRYPTS to
  // compute the title, so it must NEVER be exposed over the MCP connector — only the signed-in
  // human may see their own notes' titles. `list()` above stays the metadata-only connector path.
  listWithTitles(userId: string): Array<StickyMeta & { title: string }> {
    return this.db
      .query<Row, [string]>("SELECT * FROM sticky WHERE user_id = ? ORDER BY position")
      .all(userId)
      .map((r) => {
        const s = this.rowToSticky(r);
        return {
          id: s.id,
          position: s.position,
          char_count: s.char_count,
          is_shared: s.is_shared,
          title: deriveTitle(s.text),
        };
      });
  }

  getShared(userId: string): Sticky | null {
    const r = this.db
      .query<Row, [string]>("SELECT * FROM sticky WHERE user_id = ? AND is_shared = 1")
      .get(userId);
    return r ? this.rowToSticky(r) : null;
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
      // Encrypt both the new text AND the stashed old text under the CURRENT key, so the row's two
      // columns always share one key_id (and a rotated key lazily re-encrypts the old value here).
      const next = this.encOut(text, userId);
      const prev = this.encOut(current.text, userId); // current.text is plaintext (decrypted on read)
      this.db.run(
        `UPDATE sticky
         SET prev_text = ?, text = ?, char_count = ?, key_id = ?, version = version + 1, updated_at = ?
         WHERE user_id = ? AND id = ?`,
        [prev.stored, next.stored, text.length, next.keyId, this.now(), userId, id],
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

  getAccountByGoogleSub(googleSub: string): Account | null {
    const r = this.db
      .query<AccountRow, [string]>(
        "SELECT user_id, google_sub, email, onboarded, created_at, updated_at FROM account WHERE google_sub = ?",
      )
      .get(googleSub);
    return r ? accountRowToAccount(r) : null;
  }

  // True if an account exists for this userId. Used to invalidate a session whose account is gone
  // (e.g. after delete-everything) — a valid cookie must not outlive its account.
  hasAccount(userId: string): boolean {
    return !!this.db
      .query<{ one: number }, [string]>("SELECT 1 AS one FROM account WHERE user_id = ?")
      .get(userId);
  }

  // Full account erasure: the account row + ALL its stickies. Irreversible (the data ownership
  // exit from SPEC §11). Scoped to the one userId.
  deleteAccount(userId: string): void {
    const tx = this.db.transaction(() => {
      this.db.run("DELETE FROM sticky WHERE user_id = ?", [userId]);
      this.db.run("DELETE FROM account WHERE user_id = ?", [userId]);
    });
    tx();
  }

  // Full plaintext export of a user's data (the JSON dump from SPEC §11). Decrypts text via the
  // normal read path. Account metadata + every sticky's full text.
  exportAccount(userId: string): { account: Account | null; stickies: Sticky[] } {
    const ids = this.db
      .query<{ id: string }, [string]>("SELECT id FROM sticky WHERE user_id = ? ORDER BY position")
      .all(userId)
      .map((r) => r.id);
    const account =
      this.db
        .query<AccountRow, [string]>(
          "SELECT user_id, google_sub, email, onboarded, created_at, updated_at FROM account WHERE user_id = ?",
        )
        .get(userId) ?? null;
    return {
      account: account ? accountRowToAccount(account) : null,
      stickies: ids.map((id) => this.get(userId, id)!),
    };
  }

  // Generate (or rotate) the user's connector token. Returns the RAW token ONCE — only its hash is
  // stored, so it can never be retrieved again; regenerating overwrites (the old token stops working).
  generateConnectorToken(userId: string): string {
    const raw = `msk_${randomBytes(32).toString("base64url")}`;
    const hash = sha256(raw);
    const changed = this.db.run(
      "UPDATE account SET connector_token_hash = ?, updated_at = ? WHERE user_id = ?",
      [hash, this.now(), userId],
    );
    if (changed.changes === 0) throw new NotFoundError(`account ${userId}`);
    return raw;
  }

  // Resolve a raw connector token to its owning userId via the stored hash (indexed lookup = the
  // equality check). Returns null if no account has that token. The env bootstrap token is handled
  // separately in app.ts (resolveToken), so Andrew's existing connector keeps working.
  resolveConnectorToken(rawToken: string): string | null {
    if (!rawToken) return null;
    const r = this.db
      .query<{ user_id: string }, [string]>(
        "SELECT user_id FROM account WHERE connector_token_hash = ?",
      )
      .get(sha256(rawToken));
    return r ? r.user_id : null;
  }

  // Sign-in entry point. Returns the existing account for a returning user (NO re-seeding — the
  // onboarding blurb is never re-injected), or creates a fresh account on first sign-in and seeds
  // sticky 1 = (optional pre-auth draft) + onboarding blurb, marked as the default shared sticky.
  findOrCreateAccount(
    googleSub: string,
    opts: { email?: string; draft?: string } = {},
  ): { account: Account; created: boolean } {
    const existing = this.getAccountByGoogleSub(googleSub);
    if (existing) return { account: existing, created: false };

    const userId = randomUUID();
    const ts = this.now();
    const tx = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO account (user_id, google_sub, email, onboarded, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
        [userId, googleSub, opts.email ?? null, ts, ts],
      );
      // Sticky 1 = the carried-over draft + the onboarding blurb. Append the blurb on a fresh line;
      // if the draft is already large, trim it so draft+blurb never exceeds the cap (the blurb
      // always fits and stays intact; the user's draft is what yields).
      const draft = opts.draft ?? "";
      const seed = composeSeed(draft, ONBOARDING_BLURB);
      this.create(userId, seed, { shared: true }); // sticky 1, default shared at t=0
    });
    tx();
    return { account: this.getAccountByGoogleSub(googleSub)!, created: true };
  }
}

// Derive a nav title from a sticky's text: first non-empty line, capped to ~30 chars. Empty → a
// placeholder so the nav never shows a blank tab. Used by the human web nav only.
export function deriveTitle(text: string, max = 30): string {
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (!firstLine) return "Untitled";
  return firstLine.length > max ? firstLine.slice(0, max - 1) + "…" : firstLine;
}

// Combine the pre-auth draft with the onboarding blurb without exceeding MAX_CHARS. The blurb is
// preserved whole (it's the value-add); the draft is truncated if the two together would overflow.
export function composeSeed(draft: string, blurb: string): string {
  const sep = draft ? "\n\n" : "";
  const full = draft + sep + blurb;
  if (full.length <= MAX_CHARS) return full;
  // Keep the blurb + separator; trim the draft to fit.
  const room = MAX_CHARS - blurb.length - sep.length;
  if (room <= 0) return blurb.slice(0, MAX_CHARS); // pathological: blurb alone too big
  return draft.slice(0, room) + sep + blurb;
}
