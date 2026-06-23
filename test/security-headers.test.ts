// Security headers — HSTS. The plaintext->https hop (Fly force_https 301) is still cleartext on the
// first request; HSTS is what tells the browser to never make that hop again. Fly doesn't add it, so
// the app must. Sent only in prod (secureCookie=true) — never over http://localhost in dev.

import { test, expect } from "bun:test";
import { Store } from "../src/db.ts";
import { createApp } from "../src/app.ts";

const HSTS = "strict-transport-security";

function appWith(secureCookie: boolean) {
  const store = new Store(":memory:");
  store.create("andrew", "shared", { shared: true });
  return createApp({ store, resolveToken: (t) => (t === "tok" ? "andrew" : null), secureCookie });
}

test("prod: HSTS header is set on a normal response", async () => {
  const app = appWith(true);
  const res = await app.fetch(new Request("http://x/healthz"));
  expect(res.headers.get(HSTS)).toBe("max-age=63072000; includeSubDomains; preload");
});

test("prod: HSTS header is set even on the /mcp 401 (unauthenticated)", async () => {
  const app = appWith(true);
  const res = await app.fetch(
    new Request("http://x/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  expect(res.status).toBe(401);
  expect(res.headers.get(HSTS)).toBe("max-age=63072000; includeSubDomains; preload");
});

test("dev: HSTS header is NOT set over http (secureCookie=false)", async () => {
  const app = appWith(false);
  const res = await app.fetch(new Request("http://x/healthz"));
  expect(res.headers.get(HSTS)).toBeNull();
});
