// Phase 2 step 5a — per-user connector tokens. Lets a guest use THEIR OWN Claude against THEIR OWN
// stickies. Proves: two tokens resolve to two different users, rotation invalidates the old token,
// the env bootstrap token still works (Andrew unbroken), and only the hash is stored (never raw).

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

test("two users get distinct tokens that resolve to their own userId", () => {
  const a = store.findOrCreateAccount("sub-A").account;
  const b = store.findOrCreateAccount("sub-B").account;
  const tokA = store.generateConnectorToken(a.user_id);
  const tokB = store.generateConnectorToken(b.user_id);
  expect(tokA).not.toBe(tokB);
  expect(tokA.startsWith("msk_")).toBe(true);
  expect(store.resolveConnectorToken(tokA)).toBe(a.user_id);
  expect(store.resolveConnectorToken(tokB)).toBe(b.user_id);
  expect(store.resolveConnectorToken("msk_nonexistent")).toBeNull();
});

test("rotation: regenerating invalidates the old token", () => {
  const a = store.findOrCreateAccount("sub-A").account;
  const first = store.generateConnectorToken(a.user_id);
  const second = store.generateConnectorToken(a.user_id);
  expect(first).not.toBe(second);
  expect(store.resolveConnectorToken(first)).toBeNull(); // old one dead
  expect(store.resolveConnectorToken(second)).toBe(a.user_id);
});

test("only the HASH is stored, never the raw token", () => {
  const path = join(tmpdir(), `ms-tok-${randomBytes(4).toString("hex")}.db`);
  try {
    const s = new Store(path);
    const a = s.findOrCreateAccount("sub-A").account;
    const raw = s.generateConnectorToken(a.user_id);
    s.close();
    const db = new Database(path);
    const row = db.query<{ connector_token_hash: string }, []>(
      "SELECT connector_token_hash FROM account LIMIT 1",
    ).get()!;
    expect(row.connector_token_hash).not.toBe(raw); // not the raw token
    expect(row.connector_token_hash).toBe(createHash("sha256").update(raw).digest("hex"));
    db.close();
  } finally {
    for (const sfx of ["", "-wal", "-shm"]) rmSync(path + sfx, { force: true });
  }
});

test("generateConnectorToken on a missing account throws", () => {
  expect(() => store.generateConnectorToken("ghost")).toThrow();
});

// --- end-to-end: a per-user token authenticates the /mcp connector to that user's stickies ---

test("the /mcp connector accepts BOTH the env bootstrap token AND a per-user token", async () => {
  // Andrew is the env bootstrap user; a guest signs in and gets their own token.
  const guest = store.findOrCreateAccount("guest-sub", { draft: "guest's note" }).account;
  const guestToken = store.generateConnectorToken(guest.user_id);

  const app = createApp({
    store,
    // env bootstrap: this exact token → "andrew"
    resolveToken: (t) => (t === "ENV-BOOTSTRAP" ? "andrew" : null),
  });
  // seed andrew (the bootstrap user) a sticky too
  store.create("andrew", "andrew's note", { shared: true });

  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const base = `http://localhost:${server.port}`;
  const connect = async (token: string) => {
    const c = new Client({ name: "tok-test", version: "0" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return c;
  };
  const read = async (c: Client) => {
    const res = (await c.callTool({ name: "whoami", arguments: {} })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(res.content[0].text).text as string;
  };

  try {
    // env bootstrap token → andrew's sticky
    const ca = await connect("ENV-BOOTSTRAP");
    expect(await read(ca)).toBe("andrew's note");
    await ca.close();

    // per-user token → the GUEST's own sticky (isolation: not andrew's)
    const cg = await connect(guestToken);
    expect(await read(cg)).toContain("guest's note");
    await cg.close();

    // a bogus token is rejected
    const bad = new Client({ name: "bad", version: "0" });
    await expect(
      bad.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { Authorization: "Bearer msk_bogus" } },
        }),
      ),
    ).rejects.toThrow();
  } finally {
    server.stop(true);
  }
});
