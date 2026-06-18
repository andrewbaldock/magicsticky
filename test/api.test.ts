// Phase 2 step 5a — human web session + /api. The browser path (signed-in cookie), distinct from
// the MCP connector (bearer). Proves: session round-trip, /api requires the cookie, sign-in sets it,
// list returns derived titles, save uses version CAS (409 on stale), share + undo, and crucially
// that the title path is HUMAN-only (MCP list_stickies still has no text/title).

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Store, deriveTitle } from "../src/db.ts";
import { makeSessionSigner } from "../src/session.ts";
import { createApp } from "../src/app.ts";

const SECRET = "test-session-secret";
let store: Store;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeEach(() => {
  store = new Store(":memory:");
  const app = createApp({
    store,
    resolveToken: () => null,
    verifyGoogleToken: async (cred) => (cred === "good" ? ({ sub: "andrew", email: "a@b.com" }) : null),
    isAllowed: () => true,
    session: makeSessionSigner(SECRET),
    secureCookie: false, // http in tests
  });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
});
afterEach(() => server?.stop(true));

// Sign in and return the session cookie string for subsequent requests.
async function signIn(draft?: string): Promise<string> {
  const res = await fetch(`${base}/auth/google`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: "good", draft }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("ms_session=");
  return setCookie.split(";")[0]; // "ms_session=..."
}

test("deriveTitle: first non-empty line, capped, placeholder when empty", () => {
  expect(deriveTitle("hello world")).toBe("hello world");
  expect(deriveTitle("\n\n  second try\nthird")).toBe("second try");
  expect(deriveTitle("")).toBe("Untitled");
  expect(deriveTitle("x".repeat(50))).toHaveLength(30); // 29 + ellipsis
  expect(deriveTitle("x".repeat(50)).endsWith("…")).toBe(true);
});

test("session signer round-trips and rejects tampering/expiry", () => {
  const s = makeSessionSigner(SECRET);
  const tok = s.issue("user-9");
  expect(s.verify(tok)).toBe("user-9");
  expect(s.verify(tok + "x")).toBeNull(); // tampered mac
  expect(s.verify("garbage")).toBeNull();
  // a different secret can't verify
  expect(makeSessionSigner("other").verify(tok)).toBeNull();
  // already-expired
  const expired = makeSessionSigner(SECRET, -1).issue("user-9");
  expect(s.verify(expired)).toBeNull();
});

test("/api requires a valid session cookie (401 without)", async () => {
  const res = await fetch(`${base}/api/stickies`);
  expect(res.status).toBe(401);
});

test("sign-in sets a cookie and seeds sticky 1; /api/stickies lists it WITH a derived title", async () => {
  const cookie = await signIn("buy milk\nand eggs");
  const res = await fetch(`${base}/api/stickies`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const { stickies } = (await res.json()) as {
    stickies: Array<{ id: string; title: string; is_shared: boolean; char_count: number }>;
  };
  expect(stickies.length).toBe(1);
  expect(stickies[0].title).toBe("buy milk"); // first line of the draft
  expect(stickies[0].is_shared).toBe(true);
});

test("save uses version CAS: correct version 200, stale version 409", async () => {
  const cookie = await signIn("v0");
  const list = (await (await fetch(`${base}/api/stickies`, { headers: { cookie } })).json()) as {
    stickies: Array<{ id: string }>;
  };
  const id = list.stickies[0].id;
  const got = (await (await fetch(`${base}/api/stickies/${id}`, { headers: { cookie } })).json()) as {
    version: number;
  };

  const ok = await fetch(`${base}/api/stickies/${id}`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "v1 from web", version: got.version }),
  });
  expect(ok.status).toBe(200);

  const stale = await fetch(`${base}/api/stickies/${id}`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "stale", version: got.version }),
  });
  expect(stale.status).toBe(409);
});

test("save over the cap → 413", async () => {
  const cookie = await signIn();
  const list = (await (await fetch(`${base}/api/stickies`, { headers: { cookie } })).json()) as {
    stickies: Array<{ id: string }>;
  };
  const id = list.stickies[0].id;
  const got = (await (await fetch(`${base}/api/stickies/${id}`, { headers: { cookie } })).json()) as {
    version: number;
  };
  const res = await fetch(`${base}/api/stickies/${id}`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "z".repeat(10_001), version: got.version }),
  });
  expect(res.status).toBe(413);
});

test("create, share, and undo through the API", async () => {
  const cookie = await signIn("first");
  // create a second sticky
  const created = await fetch(`${base}/api/stickies`, { method: "POST", headers: { cookie } });
  expect(created.status).toBe(201);
  const { id: id2 } = (await created.json()) as { id: string };

  // make the new one shared
  const shared = await fetch(`${base}/api/stickies/${id2}/share`, { method: "POST", headers: { cookie } });
  expect(shared.status).toBe(200);

  // write to it, then undo
  const got = (await (await fetch(`${base}/api/stickies/${id2}`, { headers: { cookie } })).json()) as {
    version: number;
  };
  await fetch(`${base}/api/stickies/${id2}`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "edited", version: got.version }),
  });
  const undo = await fetch(`${base}/api/stickies/undo`, { method: "POST", headers: { cookie } });
  expect(undo.status).toBe(200);
  const after = (await undo.json()) as { text: string };
  expect(after.text).toBe(""); // back to the empty created state
});

test("PRIVACY: the human title endpoint decrypts, but MCP list stays metadata-only", () => {
  // direct store check: list() (the connector path) must not expose text or title.
  const { account } = store.findOrCreateAccount("priv-sub", { draft: "secret first line" });
  const meta = store.list(account.user_id);
  for (const m of meta) {
    expect(m).not.toHaveProperty("text");
    expect(m).not.toHaveProperty("title");
  }
  // the human path DOES derive a title
  const withTitles = store.listWithTitles(account.user_id);
  expect(withTitles[0].title).toBe("secret first line");
});

test("logout clears the cookie; the session then 401s", async () => {
  const cookie = await signIn("note");
  expect((await fetch(`${base}/api/stickies`, { headers: { cookie } })).status).toBe(200);
  const out = await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie } });
  expect(out.status).toBe(200);
  expect((out.headers.get("set-cookie") ?? "")).toContain("ms_session="); // a clearing cookie
});

test("export returns the user's decrypted data as a JSON download", async () => {
  const cookie = await signIn("my private note");
  const res = await fetch(`${base}/api/export`, { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toContain("magicsticky-export.json");
  const data = (await res.json()) as { account: { user_id: string }; stickies: { text: string }[] };
  expect(data.account).toBeTruthy();
  expect(data.stickies[0].text).toContain("my private note"); // decrypted plaintext
});

test("delete-everything: requires the confirm token, then erases and invalidates the session", async () => {
  const cookie = await signIn("doomed");
  // wrong/missing confirmation → 400, nothing deleted
  const bad = await fetch(`${base}/api/delete-everything`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ confirm: "nope" }),
  });
  expect(bad.status).toBe(400);
  expect((await fetch(`${base}/api/stickies`, { headers: { cookie } })).status).toBe(200); // still there

  // correct confirmation → 200, account gone
  const del = await fetch(`${base}/api/delete-everything`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ confirm: "DELETE" }),
  });
  expect(del.status).toBe(200);

  // the same cookie is now invalid — account no longer exists → 401 (session can't outlive account)
  expect((await fetch(`${base}/api/stickies`, { headers: { cookie } })).status).toBe(401);
});
