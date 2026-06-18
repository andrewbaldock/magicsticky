// Phase 2 step 3 — Google sign-in + account creation + sticky-1 seeding.
// Google token VERIFICATION is seamed (injected fake), so the account/seeding logic is fully
// tested without live Google credentials. The real verifier drops into server-http.ts.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Store, composeSeed, ONBOARDING_BLURB, MAX_CHARS } from "../src/db.ts";
import { createApp, type GoogleIdentity } from "../src/app.ts";

let store: Store;

beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => {
  store.close();
});

// --- store-level: findOrCreateAccount + seeding ---

test("first sign-in creates an account and seeds sticky 1 (draft + blurb), marked shared", () => {
  const { account, created } = store.findOrCreateAccount("google-sub-1", {
    email: "a@b.com",
    draft: "remember the milk",
  });
  expect(created).toBe(true);
  expect(account.onboarded).toBe(true);

  const shared = store.getShared(account.user_id)!;
  expect(shared.position).toBe(0); // sticky 1
  expect(shared.is_shared).toBe(true);
  expect(shared.text).toContain("remember the milk"); // the draft
  expect(shared.text).toContain("shared prompt"); // the blurb
});

test("returning user gets the same account back and is NOT re-seeded (blurb never re-injects)", () => {
  const first = store.findOrCreateAccount("google-sub-2", { draft: "hello" });
  // mutate sticky 1 as the user would
  const shared = store.getShared(first.account.user_id)!;
  store.writeShared(first.account.user_id, shared.id, "I deleted the blurb", shared.version);

  const second = store.findOrCreateAccount("google-sub-2", { draft: "ignored second time" });
  expect(second.created).toBe(false);
  expect(second.account.user_id).toBe(first.account.user_id);
  // still exactly one sticky, and the user's edit stands — no re-seed appended a new blurb
  expect(store.list(second.account.user_id).length).toBe(1);
  expect(store.getShared(second.account.user_id)!.text).toBe("I deleted the blurb");
});

test("sign-in with no draft seeds sticky 1 with just the blurb", () => {
  const { account } = store.findOrCreateAccount("google-sub-3");
  expect(store.getShared(account.user_id)!.text).toBe(ONBOARDING_BLURB);
});

// --- composeSeed cap-guard ---

test("composeSeed keeps draft+blurb under the cap; blurb survives whole, draft yields", () => {
  expect(composeSeed("", ONBOARDING_BLURB)).toBe(ONBOARDING_BLURB);
  expect(composeSeed("hi", "BLURB")).toBe("hi\n\nBLURB");

  // an over-cap draft: result must be <= cap, end with the full blurb, and have truncated the draft
  const huge = "x".repeat(MAX_CHARS);
  const seed = composeSeed(huge, ONBOARDING_BLURB);
  expect(seed.length).toBeLessThanOrEqual(MAX_CHARS);
  expect(seed.endsWith(ONBOARDING_BLURB)).toBe(true);
  expect(seed.startsWith("x")).toBe(true);
});

test("a too-large draft cannot push sticky 1 over the cap on real signup", () => {
  const { account } = store.findOrCreateAccount("google-sub-4", {
    draft: "y".repeat(MAX_CHARS + 5000),
  });
  const shared = store.getShared(account.user_id)!;
  expect(shared.char_count).toBeLessThanOrEqual(MAX_CHARS);
  expect(shared.text.endsWith(ONBOARDING_BLURB)).toBe(true);
});

// --- HTTP route /auth/google with a fake verifier ---

function appWith(
  verify: (cred: string) => Promise<GoogleIdentity | null>,
  isAllowed: (id: GoogleIdentity) => boolean = () => true,
) {
  const app = createApp({
    store,
    resolveToken: () => null,
    verifyGoogleToken: verify,
    isAllowed,
  });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  return { server, base: `http://localhost:${server.port}` };
}

test("POST /auth/google: valid credential signs in, seeds, reports created", async () => {
  const fake = async (cred: string): Promise<GoogleIdentity | null> =>
    cred === "good" ? { sub: "sub-http", email: "x@y.com" } : null;
  const { server, base } = appWith(fake);
  try {
    const res = await fetch(`${base}/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: "good", draft: "my draft note" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; created: boolean };
    expect(json.created).toBe(true);
    // response no longer leaks the internal user_id — look the account up by its Google sub
    const acct = store.getAccountByGoogleSub("sub-http")!;
    const shared = store.getShared(acct.user_id)!;
    expect(shared.text).toContain("my draft note");

    // second call with the same sub → created:false, no re-seed
    const res2 = await fetch(`${base}/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: "good" }),
    });
    const json2 = (await res2.json()) as { created: boolean };
    expect(json2.created).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("POST /auth/google: invalid credential → 401; missing → 400", async () => {
  const fake = async (cred: string): Promise<GoogleIdentity | null> =>
    cred === "good" ? { sub: "s" } : null;
  const { server, base } = appWith(fake);
  try {
    const bad = await fetch(`${base}/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: "forged" }),
    });
    expect(bad.status).toBe(401);

    const missing = await fetch(`${base}/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
  } finally {
    server.stop(true);
  }
});

test("POST /auth/google: a non-allowlisted identity is rejected 403 and creates NOTHING", async () => {
  const fake = async (): Promise<GoogleIdentity> => ({ sub: "stranger", email: "stranger@evil.com" });
  // allow only andrew; the stranger above is not allowed
  const { server, base } = appWith(fake, (id) => id.email === "andrew@ok.com");
  try {
    const res = await fetch(`${base}/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: "valid-but-unwelcome", draft: "should not persist" }),
    });
    expect(res.status).toBe(403);
    // crucial: no account/sticky was created for the rejected identity
    expect(store.getAccountByGoogleSub("stranger")).toBeNull();
  } finally {
    server.stop(true);
  }
});

test("POST /auth/google: an allowlisted identity is admitted", async () => {
  const fake = async (): Promise<GoogleIdentity> => ({ sub: "andrew", email: "andrew@ok.com" });
  const { server, base } = appWith(fake, (id) => id.email === "andrew@ok.com");
  try {
    const res = await fetch(`${base}/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: "ok" }),
    });
    expect(res.status).toBe(200);
    expect(store.getAccountByGoogleSub("andrew")).not.toBeNull();
  } finally {
    server.stop(true);
  }
});

test("createApp defaults to deny-all sign-in when no allowlist is given", async () => {
  const fake = async (): Promise<GoogleIdentity> => ({ sub: "anyone", email: "a@b.com" });
  // build WITHOUT isAllowed → default deny-all
  const app = createApp({ store, resolveToken: () => null, verifyGoogleToken: fake });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  try {
    const res = await fetch(`http://localhost:${server.port}/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: "ok" }),
    });
    expect(res.status).toBe(403);
  } finally {
    server.stop(true);
  }
});

test("POST /auth/google: 501 when google sign-in is not configured", async () => {
  const app = createApp({ store, resolveToken: () => null }); // no verifyGoogleToken
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  try {
    const res = await fetch(`http://localhost:${server.port}/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: "x" }),
    });
    expect(res.status).toBe(501);
  } finally {
    server.stop(true);
  }
});
