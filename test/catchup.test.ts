// Offline catch-up append logic. Append-only (conflict-free): "text" → lowest non-shared sticky
// (auto-create if none), "claude" → the shared sticky. Always below a timestamped divider.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Store, MAX_CHARS } from "../src/db.ts";

const STAMP = "3.16.2025 10:06am";
let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

function userWithStack() {
  const { account } = store.findOrCreateAccount("sub", {}); // seeds sticky-1 (shared) at position 0
  const u = account.user_id;
  const a = store.create(u, "first note", { shared: false }); // position 1
  store.create(u, "second note", { shared: false }); // position 2
  return { u, lowestNonSharedId: a.id };
}

test("claude catch-up appends below a divider to the SHARED sticky", () => {
  const { account } = store.findOrCreateAccount("sub", {});
  const u = account.user_id;
  const before = store.getShared(u)!.text;

  const s = store.appendCatchUp(u, "claude", "ping me about the interview", STAMP);
  expect(s.is_shared).toBe(true);
  expect(s.text.startsWith(before)).toBe(true); // original preserved (append-only)
  expect(s.text).toContain(`------ pwa catch-up ${STAMP} -----`);
  expect(s.text).toContain("ping me about the interview");
  // the note comes AFTER the divider
  expect(s.text.indexOf("ping me")).toBeGreaterThan(s.text.indexOf("catch-up"));
});

test("text catch-up appends to the LOWEST non-shared sticky, not the shared one", () => {
  const { u, lowestNonSharedId } = userWithStack();
  const sharedBefore = store.getShared(u)!.text;

  const s = store.appendCatchUp(u, "text", "buy milk", STAMP);
  expect(s.id).toBe(lowestNonSharedId);
  expect(s.is_shared).toBe(false);
  expect(s.text).toContain("first note"); // original kept
  expect(s.text).toContain(`------ pwa catch-up ${STAMP} -----`);
  expect(s.text).toContain("buy milk");
  // shared sticky was untouched
  expect(store.getShared(u)!.text).toBe(sharedBefore);
});

test("text catch-up auto-creates a sticky when there is NO non-shared one", () => {
  const { account } = store.findOrCreateAccount("sub", {}); // only the shared sticky exists
  const u = account.user_id;
  expect(store.lowestNonShared(u)).toBeNull();

  const s = store.appendCatchUp(u, "text", "orphan thought", STAMP);
  expect(s.is_shared).toBe(false); // landed in a freshly-created non-shared sticky
  expect(s.text).toContain("orphan thought");
  // shared sticky still pristine (its seeded blurb), not touched
  expect(store.getShared(u)!.text).not.toContain("orphan thought");
  expect(store.list(u).length).toBe(2); // shared + the auto-created one
});

test("append is conflict-free: a concurrent edit elsewhere is preserved", () => {
  const { u, lowestNonSharedId } = userWithStack();
  // simulate the sticky changing (someone edited it) between offline-capture and reconnect
  const cur = store.get(u, lowestNonSharedId)!;
  store.writeShared(u, lowestNonSharedId, "EDITED LIVE", cur.version);
  // the catch-up still appends on top of the live edit — nothing lost
  const s = store.appendCatchUp(u, "text", "offline thought", STAMP);
  expect(s.text).toContain("EDITED LIVE");
  expect(s.text).toContain("offline thought");
});

test("append respects the 10k cap (throws rather than silently truncating)", () => {
  const { account } = store.findOrCreateAccount("sub", {});
  const u = account.user_id;
  const shared = store.getShared(u)!;
  store.writeShared(u, shared.id, "x".repeat(MAX_CHARS - 10), shared.version);
  expect(() => store.appendCatchUp(u, "claude", "this would overflow the cap", STAMP)).toThrow();
});
