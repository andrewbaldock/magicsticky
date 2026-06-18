// Magic Sticky — app-layer column encryption (SPEC §11). AEAD (AES-256-GCM) on the sticky text at
// rest, with a SERVER-HELD key. This is NOT end-to-end encryption: the running server decrypts to
// serve the shared prompt to Claude (E2EE is incompatible with "any Claude reads it"). The goal is
// narrow — a leaked DB file / backup isn't plaintext.
//
// Keys are versioned by a short key-id stored per row, so a future key can be added and rows
// re-encrypted lazily on next write without a migration. Encryption lives INSIDE the Store, so
// callers always pass and receive plaintext and char_count stays a plaintext length.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96-bit nonce, standard for GCM
const TAG_LEN = 16;

export interface Cipher {
  // Returns the key-id used and an opaque ciphertext blob (iv|tag|data, base64). `aad` (additional
  // authenticated data, e.g. the owning user_id) is bound into the auth tag — the same `aad` must
  // be supplied to decrypt, so a blob only decrypts in its own context (defends against row-swaps
  // / cross-user mixups once more than one human's data shares the DB).
  encrypt(plaintext: string, aad?: string): { keyId: string; ciphertext: string };
  // Decrypts a blob produced by encrypt() under the given key-id and the SAME aad.
  decrypt(ciphertext: string, keyId: string, aad?: string): string;
}

// An AEAD cipher over a set of named 32-byte keys. `primaryKeyId` is used for new writes; older
// key-ids stay available for decrypting existing rows (rotation).
export class AeadCipher implements Cipher {
  private keys: Map<string, Buffer>;
  private primaryKeyId: string;

  constructor(keys: Record<string, Buffer>, primaryKeyId: string) {
    this.keys = new Map(Object.entries(keys));
    if (!this.keys.has(primaryKeyId)) throw new Error(`primary key "${primaryKeyId}" not in key set`);
    for (const [id, k] of this.keys) {
      if (k.length !== 32) throw new Error(`key "${id}" must be 32 bytes (got ${k.length})`);
    }
    this.primaryKeyId = primaryKeyId;
  }

  encrypt(plaintext: string, aad?: string): { keyId: string; ciphertext: string } {
    const key = this.keys.get(this.primaryKeyId)!;
    const iv = randomBytes(IV_LEN);
    const c = createCipheriv(ALGO, key, iv);
    if (aad) c.setAAD(Buffer.from(aad, "utf8"));
    const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    const tag = c.getAuthTag();
    return { keyId: this.primaryKeyId, ciphertext: Buffer.concat([iv, tag, enc]).toString("base64") };
  }

  decrypt(ciphertext: string, keyId: string, aad?: string): string {
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`no key for id "${keyId}" — cannot decrypt`);
    const buf = Buffer.from(ciphertext, "base64");
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const data = buf.subarray(IV_LEN + TAG_LEN);
    const d = createDecipheriv(ALGO, key, iv);
    if (aad) d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  }
}

// Parse keys from an env string of the form "id1:hexkey1,id2:hexkey2". The first listed is primary.
// Returns null if the env is empty (encryption disabled — dev/test plaintext).
export function cipherFromEnv(env: string | undefined): Cipher | null {
  if (!env || !env.trim()) return null;
  const entries = env.split(",").map((p) => p.trim()).filter(Boolean);
  const keys: Record<string, Buffer> = {};
  let primary = "";
  for (const e of entries) {
    const idx = e.indexOf(":");
    if (idx < 0) throw new Error(`bad key entry "${e}" — expected id:hexkey`);
    const id = e.slice(0, idx);
    const hex = e.slice(idx + 1);
    const buf = Buffer.from(hex, "hex");
    keys[id] = buf;
    if (!primary) primary = id;
  }
  return new AeadCipher(keys, primary);
}
