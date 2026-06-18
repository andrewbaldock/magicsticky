// Phase 2 — OAuth Authorization Server, end to end over the wire. Proves the desktop/phone connector
// flow: a 401 from /mcp carries the discovery header, the two .well-known docs resolve, DCR mints a
// client, authorize→approve→token round-trips, and the issued token then authenticates /mcp via the
// real SDK client. The human-session leg is stubbed by issuing a session cookie directly (the test
// owns the signer), which stands in for "the human already signed in with Google."

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { makeSessionSigner } from "../src/session.ts";
import { computeS256Challenge } from "../src/oauth.ts";

const PUBLIC_URL = "https://magicsticky.test"; // canonical origin (issuer + resource id)
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let store: Store;
let userId: string;
let sessionCookie: string;

beforeEach(() => {
  store = new Store(":memory:");
  // A real account (so hasAccount passes in /oauth/authorize) with a shared sticky to read after.
  userId = store.findOrCreateAccount("google-sub", { draft: "the shared prompt" }).account.user_id;

  const signer = makeSessionSigner("test-session-secret");
  sessionCookie = `ms_session=${signer.issue(userId)}`;

  const app = createApp({
    store,
    resolveToken: () => null, // no env bootstrap token in this test; OAuth tokens do the work
    session: signer,
    secureCookie: false,
    publicUrl: PUBLIC_URL,
    googleClientId: "test-client.apps.googleusercontent.com",
  });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  baseUrl = `http://localhost:${server.port}`;
});

afterEach(() => {
  server?.stop(true);
  store?.close();
});

test("an unauthenticated /mcp request 401s WITH a WWW-Authenticate discovery header", async () => {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(res.status).toBe(401);
  const wa = res.headers.get("WWW-Authenticate") ?? "";
  expect(wa).toContain("resource_metadata=");
  expect(wa).toContain("/.well-known/oauth-protected-resource");
});

test("the two .well-known metadata docs resolve and advertise the mandatory fields", async () => {
  const prm = (await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)).json()) as {
    resource: string;
    authorization_servers: string[];
  };
  expect(prm.resource).toBe(PUBLIC_URL);
  expect(prm.authorization_servers).toEqual([PUBLIC_URL]);

  const asm = (await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  expect(asm.code_challenge_methods_supported).toEqual(["S256"]); // clients refuse without this
  expect(asm.authorization_endpoint).toBe(`${PUBLIC_URL}/oauth/authorize`);
  expect(asm.token_endpoint).toBe(`${PUBLIC_URL}/oauth/token`);
  expect(asm.registration_endpoint).toBe(`${PUBLIC_URL}/oauth/register`);
});

test("DCR mints a client; full authorize→approve→token yields a token that authenticates /mcp", async () => {
  // 1. Dynamic client registration (zero-config path).
  const reg = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude Desktop" }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };
  expect(typeof client_id).toBe("string");

  // 2. PKCE pair.
  const verifier = "test-verifier-0123456789-abcdefghijklmnop";
  const challenge = computeS256Challenge(verifier);
  const authQuery = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: PUBLIC_URL,
    state: "xyz",
  });

  // 3. Authorize — signed in (cookie present) → consent page (not a sign-in page).
  const authRes = await fetch(`${baseUrl}/oauth/authorize?${authQuery}`, {
    headers: { Cookie: sessionCookie },
  });
  expect(authRes.status).toBe(200);
  const html = await authRes.text();
  expect(html).toContain("/oauth/authorize/approve"); // it's the consent form, not the GIS sign-in

  // 4. Approve → 302 back to the redirect_uri with ?code (+ state echoed).
  const approve = await fetch(`${baseUrl}/oauth/authorize/approve`, {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ params: authQuery.toString() }),
    redirect: "manual",
  });
  expect(approve.status).toBe(302);
  const loc = new URL(approve.headers.get("Location")!);
  expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
  expect(loc.searchParams.get("state")).toBe("xyz");
  const code = loc.searchParams.get("code")!;
  expect(code).toBeTruthy();

  // 5. Token — exchange code + PKCE verifier for the access_token (a connector token).
  const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id,
      redirect_uri: REDIRECT,
    }),
  });
  expect(tokenRes.status).toBe(200);
  const tok = (await tokenRes.json()) as { token_type: string; access_token: string };
  expect(tok.token_type).toBe("Bearer");
  expect(tok.access_token).toStartWith("msk_");

  // 6. The token authenticates /mcp — the whole point. whoami returns the shared sticky.
  const c = new Client({ name: "oauth-e2e", version: "0" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } },
    }),
  );
  const res = (await c.callTool({ name: "whoami", arguments: {} })) as {
    content: Array<{ text: string }>;
  };
  expect(JSON.parse(res.content[0].text).text).toContain("the shared prompt");
  await c.close();
});

test("authorize WITHOUT a session shows the Google sign-in page (not consent)", async () => {
  const regRes = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT] }),
  });
  const reg = (await regRes.json()) as { client_id: string };
  const q = new URLSearchParams({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    code_challenge: "ch",
    code_challenge_method: "S256",
  });
  const res = await fetch(`${baseUrl}/oauth/authorize?${q}`); // no cookie
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("accounts.google.com/gsi/client"); // the sign-in button, not consent
  expect(html).not.toContain("/oauth/authorize/approve");
});

test("the token endpoint rejects a wrong PKCE verifier (invalid_grant)", async () => {
  const regRes = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT] }),
  });
  const reg = (await regRes.json()) as { client_id: string };
  const challenge = computeS256Challenge("the-real-verifier-xxxxxxxxxxxxxxxxxxxx");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const approve = await fetch(`${baseUrl}/oauth/authorize/approve`, {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ params: q.toString() }),
    redirect: "manual",
  });
  const code = new URL(approve.headers.get("Location")!).searchParams.get("code")!;

  const bad = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: "the-WRONG-verifier-yyyyyyyyyyyyyyyyyy",
      client_id: reg.client_id,
      redirect_uri: REDIRECT,
    }),
  });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toBe("invalid_grant");
});

test("when OAuth is NOT configured, the discovery routes 501 and /mcp 401 has no discovery header", async () => {
  const bareStore = new Store(":memory:");
  const app = createApp({ store: bareStore, resolveToken: () => null }); // no publicUrl/session
  const s = Bun.serve({ port: 0, fetch: app.fetch });
  const url = `http://localhost:${s.port}`;
  try {
    expect((await fetch(`${url}/.well-known/oauth-protected-resource`)).status).toBe(501);
    const mcp = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("WWW-Authenticate")).toBeNull();
  } finally {
    s.stop(true);
    bareStore.close();
  }
});
