// Phase 2 step 1 — store invariants. Cowork's gating asks: both stale-write directions must
// reject, over-cap rejects, single-shared holds, and list() leaks no text.

import { test, expect, beforeEach } from "bun:test";
import {
  Store,
  MAX_CHARS,
  VersionConflictError,
  TooLongError,
  NotFoundError,
} from "../src/db.ts";

const USER = "user-1";
let store: Store;

beforeEach(() => {
  store = new Store(":memory:"); // fresh in-memory db per test
});

test("create seeds positions in order and a shared sticky", () => {
  const a = store.create(USER, "first", { shared: true });
  const b = store.create(USER, "second");
  expect(a.position).toBe(0);
  expect(b.position).toBe(1);
  expect(a.is_shared).toBe(true);
  expect(b.is_shared).toBe(false);
  expect(a.version).toBe(0);
});

test("at most one shared sticky per user — creating/flipping moves the flag", () => {
  const a = store.create(USER, "a", { shared: true });
  const b = store.create(USER, "b", { shared: true }); // should steal shared from a
  expect(store.get(USER, a.id)!.is_shared).toBe(false);
  expect(store.get(USER, b.id)!.is_shared).toBe(true);

  store.setShared(USER, a.id); // flip back
  expect(store.get(USER, a.id)!.is_shared).toBe(true);
  expect(store.get(USER, b.id)!.is_shared).toBe(false);

  // exactly one shared at all times
  const sharedCount = store.list(USER).filter((s) => s.is_shared).length;
  expect(sharedCount).toBe(1);
});

test("list() returns METADATA ONLY — never the text of any sticky", () => {
  store.create(USER, "secret contents here", { shared: true });
  store.create(USER, "another private note");
  const metas = store.list(USER);
  expect(metas.length).toBe(2);
  for (const m of metas) {
    expect(m).not.toHaveProperty("text");
    expect(m).not.toHaveProperty("prev_text");
    expect(Object.keys(m).sort()).toEqual(["char_count", "id", "is_shared", "position"]);
  }
  // char_count is correct without exposing text
  expect(metas[0].char_count).toBe("secret contents here".length);
});

test("writeShared compare-and-swap: correct version succeeds, bumps version, stashes undo", () => {
  const s = store.create(USER, "v0 text", { shared: true });
  expect(s.version).toBe(0);
  const after = store.writeShared(USER, s.id, "v1 text", 0);
  expect(after.text).toBe("v1 text");
  expect(after.version).toBe(1);
  expect(after.prev_text).toBe("v0 text"); // 1-deep undo stash
});

test("writeShared rejects a stale version (the clobber guard)", () => {
  const s = store.create(USER, "v0", { shared: true });
  store.writeShared(USER, s.id, "v1", 0); // version -> 1
  // a writer still holding version 0 must be rejected
  expect(() => store.writeShared(USER, s.id, "stale overwrite", 0)).toThrow(VersionConflictError);
  expect(store.getShared(USER)!.text).toBe("v1"); // unchanged
});

test("BOTH stale directions reject — simulating UI-save vs tool-write races", () => {
  const s = store.create(USER, "base", { shared: true });

  // Direction 1: "tool" writes first (v0 -> v1), then a stale "UI" save at v0 rejects.
  store.writeShared(USER, s.id, "from tool", 0);
  expect(() => store.writeShared(USER, s.id, "stale from UI", 0)).toThrow(VersionConflictError);

  // Re-read, both go through the SAME store path; whoever reads the new version wins.
  const fresh = store.getShared(USER)!;
  expect(fresh.version).toBe(1);

  // Direction 2: "UI" writes at the fresh version (v1 -> v2), then a stale "tool" at v1 rejects.
  store.writeShared(USER, s.id, "from UI", fresh.version);
  expect(() => store.writeShared(USER, s.id, "stale from tool", 1)).toThrow(VersionConflictError);
  expect(store.getShared(USER)!.text).toBe("from UI");
  expect(store.getShared(USER)!.version).toBe(2);
});

test("writeShared enforces the 10k cap and fails loudly", () => {
  const s = store.create(USER, "", { shared: true });
  const tooBig = "x".repeat(MAX_CHARS + 1);
  expect(() => store.writeShared(USER, s.id, tooBig, 0)).toThrow(TooLongError);
  // exactly at the cap is allowed
  const ok = store.writeShared(USER, s.id, "y".repeat(MAX_CHARS), 0);
  expect(ok.text.length).toBe(MAX_CHARS);
});

test("create also enforces the cap", () => {
  expect(() => store.create(USER, "z".repeat(MAX_CHARS + 1))).toThrow(TooLongError);
});

test("undoShared swaps text <-> prev_text once, and no-ops with nothing to undo", () => {
  const s = store.create(USER, "original", { shared: true });
  expect(store.undoShared(USER)).toBeNull(); // nothing overwritten yet

  store.writeShared(USER, s.id, "edited", 0);
  const undone = store.undoShared(USER)!;
  expect(undone.text).toBe("original"); // restored
  // a second undo redoes (swap again) — 1-deep, symmetric
  const redone = store.undoShared(USER)!;
  expect(redone.text).toBe("edited");
});

test("char_count tracks plaintext length through create/write/undo (decoupled from text column)", () => {
  // This column exists so it survives step-4 encryption of `text`; assert it stays a real char count.
  const s = store.create(USER, "hello", { shared: true }); // 5
  expect(s.char_count).toBe(5);
  expect(store.list(USER)[0].char_count).toBe(5);

  const w = store.writeShared(USER, s.id, "twelve chars", 0); // 12
  expect(w.char_count).toBe(12);
  expect(store.list(USER)[0].char_count).toBe(12);

  const u = store.undoShared(USER)!; // back to "hello"
  expect(u.text).toBe("hello");
  expect(u.char_count).toBe(5);
});

test("writeShared on a missing id throws NotFound", () => {
  expect(() => store.writeShared(USER, "nope", "x", 0)).toThrow(NotFoundError);
});

test("users are isolated — one user cannot see or write another's stickies", () => {
  const mine = store.create(USER, "mine", { shared: true });
  store.create("user-2", "theirs", { shared: true });
  expect(store.get("user-2", mine.id)).toBeNull(); // wrong owner
  expect(store.list(USER).length).toBe(1);
  expect(store.list("user-2").length).toBe(1);
  // each user has their own single shared sticky (index is per-user)
  expect(store.getShared(USER)!.text).toBe("mine");
  expect(store.getShared("user-2")!.text).toBe("theirs");
});
