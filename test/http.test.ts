// Phase 2 step 2 — HTTP/MCP smoke. Boots the real Hono app over Bun.serve and drives the 4 tools
// through the SDK's Streamable-HTTP client. Cowork's gating ask: version-mismatch + over-cap
// rejections must be proven OVER THE WIRE, plus the bearer-auth gate.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store, MAX_CHARS } from "../src/db.ts";
import { createApp } from "../src/app.ts";

const TOKEN = "test-token-abc";
const USER = "andrew";
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let store: Store;

function clientFor(token: string | null) {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers } });
}

async function connect(token: string | null = TOKEN) {
  const c = new Client({ name: "http-smoke", version: "0" });
  await c.connect(clientFor(token));
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await c.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const text = res.content?.[0]?.text ?? "";
  return { isError: !!res.isError, data: res.isError ? text : JSON.parse(text) };
}

beforeEach(() => {
  // Fresh store + server per test so mutations don't leak across tests.
  store = new Store(":memory:");
  store.create(USER, "current focus: ship magic sticky", { shared: true });
  store.create(USER, "a second, non-shared note");

  const app = createApp({ store, resolveToken: (t) => (t === TOKEN ? USER : null) });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  baseUrl = `http://localhost:${server.port}`;
});

afterEach(() => {
  server?.stop(true);
  store?.close();
});

test("rejects a connection without a valid bearer token (401)", async () => {
  const c = new Client({ name: "noauth", version: "0" });
  await expect(c.connect(clientFor(null))).rejects.toThrow();
  const bad = new Client({ name: "badauth", version: "0" });
  await expect(bad.connect(clientFor("wrong-token"))).rejects.toThrow();
});

test("advertises exactly the 4 pivot tools", async () => {
  const c = await connect();
  const { tools } = await c.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(
    ["list_stickies", "set_shared", "whoami", "write"].sort(),
  );
  await c.close();
});

test("server instructions tell the client to call whoami first", async () => {
  const c = await connect();
  expect(c.getInstructions()?.toLowerCase()).toContain("whoami");
  await c.close();
});

test("whoami returns the shared sticky's text + version over the wire", async () => {
  const c = await connect();
  const { data } = await call(c, "whoami");
  expect(data.text).toBe("current focus: ship magic sticky");
  expect(typeof data.version).toBe("number");
  await c.close();
});

test("write with the correct version succeeds; list_stickies leaks no text", async () => {
  const c = await connect();
  const me = (await call(c, "whoami")).data;
  const w = (await call(c, "write", { text: "updated via MCP", version: me.version })).data;
  expect(w.text).toBe("updated via MCP");
  expect(w.version).toBe(me.version + 1);

  const list = (await call(c, "list_stickies")).data;
  expect(list.stickies.length).toBe(2);
  for (const s of list.stickies) {
    expect(s).not.toHaveProperty("text");
    expect(Object.keys(s).sort()).toEqual(["char_count", "id", "is_shared", "position"]);
  }
  await c.close();
});

test("write with a STALE version is rejected over the wire (the clobber guard)", async () => {
  const c = await connect();
  const me = (await call(c, "whoami")).data;
  // first write moves the version forward
  await call(c, "write", { text: "first", version: me.version });
  // a second write still using the old version must be rejected (isError)
  const stale = await call(c, "write", { text: "stale clobber", version: me.version });
  expect(stale.isError).toBe(true);
  expect(stale.data.toLowerCase()).toContain("version conflict");
  await c.close();
});

test("write over the 10k cap is rejected over the wire", async () => {
  const c = await connect();
  const me = (await call(c, "whoami")).data;
  const tooBig = "x".repeat(MAX_CHARS + 1);
  const res = await call(c, "write", { text: tooBig, version: me.version });
  expect(res.isError).toBe(true);
  expect(res.data).toContain(String(MAX_CHARS));
  await c.close();
});

test("set_shared flips which sticky whoami returns", async () => {
  const c = await connect();
  const list = (await call(c, "list_stickies")).data.stickies as Array<{
    id: string;
    is_shared: boolean;
  }>;
  const other = list.find((s) => !s.is_shared)!;
  await call(c, "set_shared", { id: other.id });
  const me = (await call(c, "whoami")).data;
  expect(me.text).toBe("a second, non-shared note");
  await c.close();
});
