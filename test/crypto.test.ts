// Phase 2 step 4 — AEAD encryption at rest. Proves: cipher round-trips; the Store transparently
// encrypts/decrypts (callers always see plaintext); the bytes ON DISK are ciphertext, not plaintext;
// char_count stays plaintext length; and a rotated key still decrypts old rows.

import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AeadCipher, cipherFromEnv } from "../src/crypto.ts";
import { Store } from "../src/db.ts";

const USER = "u1";
const key = () => randomBytes(32);

// temp db paths created by tests, cleaned up at the end (+ their WAL/SHM sidecars)
const tmpDbs: string[] = [];
function tmpDb(tag: string): string {
  const p = join(tmpdir(), `ms-${tag}-${randomBytes(4).toString("hex")}.db`);
  tmpDbs.push(p);
  return p;
}
afterAll(() => {
  for (const p of tmpDbs) for (const s of ["", "-wal", "-shm"]) rmSync(p + s, { force: true });
});

test("AeadCipher round-trips and rejects tampering", () => {
  const c = new AeadCipher({ k1: key() }, "k1");
  const { ciphertext, keyId } = c.encrypt("hello world");
  expect(keyId).toBe("k1");
  expect(ciphertext).not.toContain("hello"); // not plaintext
  expect(c.decrypt(ciphertext, keyId)).toBe("hello world");

  // a tampered blob fails the auth tag
  const bad = Buffer.from(ciphertext, "base64");
  bad[bad.length - 1] ^= 0xff;
  expect(() => c.decrypt(bad.toString("base64"), "k1")).toThrow();
});

test("cipherFromEnv parses id:hex,... and first is primary; empty → null", () => {
  expect(cipherFromEnv("")).toBeNull();
  expect(cipherFromEnv(undefined)).toBeNull();
  const hex = randomBytes(32).toString("hex");
  const c = cipherFromEnv(`v1:${hex}`)!;
  expect(c.encrypt("x").keyId).toBe("v1");
});

test("Store with a cipher behaves identically to plaintext (callers see plaintext)", () => {
  const c = new AeadCipher({ k1: key() }, "k1");
  const store = new Store(":memory:", c);
  const s = store.create(USER, "current focus", { shared: true });
  expect(s.text).toBe("current focus");
  expect(s.char_count).toBe("current focus".length);

  const w = store.writeShared(USER, s.id, "new context that is longer", 0);
  expect(w.text).toBe("new context that is longer");
  expect(w.char_count).toBe("new context that is longer".length);
  expect(w.prev_text).toBe("current focus"); // undo stash decrypts

  const undone = store.undoShared(USER)!;
  expect(undone.text).toBe("current focus");
  expect(undone.char_count).toBe("current focus".length);
  store.close();
});

test("the bytes ON DISK are ciphertext, not plaintext (the whole point)", () => {
  const path = tmpDb("crypto");
  const c = new AeadCipher({ k1: key() }, "k1");
  const store = new Store(path, c);
  const secret = "TOP SECRET interview notes for General Medicine";
  store.create(USER, secret, { shared: true });
  store.close();

  // reopen the raw DB WITHOUT the cipher and read the stored text column
  const raw = new Database(path);
  const row = raw.query<{ text: string; key_id: string; char_count: number }, []>(
    "SELECT text, key_id, char_count FROM sticky LIMIT 1",
  ).get()!;
  expect(row.text).not.toContain("SECRET"); // stored bytes are encrypted
  expect(row.text).not.toContain("interview");
  expect(row.key_id).toBe("k1"); // key id recorded for decryption/rotation
  expect(row.char_count).toBe(secret.length); // char_count is plaintext length, not ciphertext
  raw.close();

  // a Store WITH the key can read it back
  const reopened = new Store(path, c);
  expect(reopened.getShared(USER)!.text).toBe(secret);
  reopened.close();
});

test("rotated key: a new primary still decrypts rows written under the old key", () => {
  const path = tmpDb("rotate");
  const k1 = key();
  const k2 = key();

  // write under k1
  const s1 = new Store(path, new AeadCipher({ k1 }, "k1"));
  const sticky = s1.create(USER, "written under k1", { shared: true });
  s1.close();

  // reopen with k2 primary but k1 still present → old row decrypts, new write goes under k2
  const s2 = new Store(path, new AeadCipher({ k2, k1 }, "k2"));
  expect(s2.getShared(USER)!.text).toBe("written under k1"); // old row still readable
  s2.writeShared(USER, sticky.id, "rewritten under k2", 0); // lazily re-encrypts under k2
  expect(s2.getShared(USER)!.text).toBe("rewritten under k2");
  s2.close();

  // a store with ONLY k2 can now read the rewritten row (it's under k2)
  const s3 = new Store(path, new AeadCipher({ k2 }, "k2"));
  expect(s3.getShared(USER)!.text).toBe("rewritten under k2");
  s3.close();
});

test("AAD binds a blob to its context: same aad round-trips, wrong aad fails", () => {
  const c = new AeadCipher({ k1: key() }, "k1");
  const { ciphertext, keyId } = c.encrypt("owned by user-A", "user-A");
  expect(c.decrypt(ciphertext, keyId, "user-A")).toBe("owned by user-A");
  // wrong aad (another user_id) must fail the auth tag — defends against row/owner mixups
  expect(() => c.decrypt(ciphertext, keyId, "user-B")).toThrow();
  // missing aad also fails (it was encrypted WITH aad)
  expect(() => c.decrypt(ciphertext, keyId)).toThrow();
});

test("Store binds user_id as AAD: each user's text round-trips under its own id", () => {
  const c = new AeadCipher({ k1: key() }, "k1");
  const store = new Store(":memory:", c);
  const a = store.findOrCreateAccount("sub-A").account;
  const b = store.findOrCreateAccount("sub-B").account;
  const sa = store.getShared(a.user_id)!;
  store.writeShared(a.user_id, sa.id, "A's secret", sa.version);
  const sb = store.getShared(b.user_id)!;
  store.writeShared(b.user_id, sb.id, "B's secret", sb.version);
  // each reads its own correctly (AAD = its own user_id)
  expect(store.getShared(a.user_id)!.text).toBe("A's secret");
  expect(store.getShared(b.user_id)!.text).toBe("B's secret");
  store.close();
});

test("plaintext rows (no cipher) remain readable; key_id is null", () => {
  const path = tmpDb("plain");
  const plain = new Store(path); // no cipher
  plain.create(USER, "stored as plaintext", { shared: true });
  plain.close();

  const raw = new Database(path);
  const row = raw.query<{ text: string; key_id: string | null }, []>(
    "SELECT text, key_id FROM sticky LIMIT 1",
  ).get()!;
  expect(row.text).toBe("stored as plaintext");
  expect(row.key_id).toBeNull();
  raw.close();
});
