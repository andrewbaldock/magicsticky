// Phase 2 — OAuth AS core (pure logic) + the Store's one-shot code / multi-token storage. The HTTP
// round-trip lives in oauth-http.test.ts; this file proves the load-bearing primitives in isolation:
// PKCE S256, the code one-shot + TTL, resource/redirect/client validation.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Store } from "../src/db.ts";
import {
  computeS256Challenge,
  verifyPkceS256,
  resourceMatches,
  redirectUriAllowed,
  clientSecretMatches,
  checkAuthorizeRequest,
  asMetadata,
  protectedResourceMetadata,
} from "../src/oauth.ts";

const PUBLIC_URL = "https://magicsticky.andrewbaldock.com";

// --- PKCE (S256) ---

test("PKCE S256: the right verifier matches its challenge, a wrong one does not", () => {
  const verifier = "abc123_verifier-string-that-is-long-enough";
  const challenge = computeS256Challenge(verifier);
  expect(verifyPkceS256(verifier, challenge)).toBe(true);
  expect(verifyPkceS256("not-the-verifier", challenge)).toBe(false);
  expect(verifyPkceS256("", challenge)).toBe(false);
  expect(verifyPkceS256(verifier, "")).toBe(false);
});

// --- RFC 8707 resource matching ---

test("resourceMatches accepts the origin, a trailing slash, and the /mcp endpoint; rejects others", () => {
  expect(resourceMatches(PUBLIC_URL, PUBLIC_URL)).toBe(true);
  expect(resourceMatches(`${PUBLIC_URL}/`, PUBLIC_URL)).toBe(true);
  expect(resourceMatches(`${PUBLIC_URL}/mcp`, PUBLIC_URL)).toBe(true);
  expect(resourceMatches("https://evil.example.com", PUBLIC_URL)).toBe(false);
  expect(resourceMatches(null, PUBLIC_URL)).toBe(false);
});

// --- redirect_uri + client secret ---

test("redirectUriAllowed is EXACT match (no prefix/substring open-redirect)", () => {
  const reg = ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:5598/callback"];
  expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback", reg)).toBe(true);
  expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback/../evil", reg)).toBe(false);
  expect(redirectUriAllowed("https://claude.ai.evil.com/", reg)).toBe(false);
});

test("clientSecretMatches: public client must present none; confidential must match", () => {
  // public client (no stored secret)
  expect(clientSecretMatches(undefined, null)).toBe(true);
  expect(clientSecretMatches("anything", null)).toBe(false);
  // confidential client
  const { createHash } = require("node:crypto");
  const hash = createHash("sha256").update("s3cret").digest("hex");
  expect(clientSecretMatches("s3cret", hash)).toBe(true);
  expect(clientSecretMatches("wrong", hash)).toBe(false);
  expect(clientSecretMatches(undefined, hash)).toBe(false);
});

// --- authorize request validation ---

function authParams(over: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: "c1",
    redirect_uri: "https://claude.ai/cb",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    resource: PUBLIC_URL,
    ...over,
  });
}
const client = { client_id: "c1", redirect_uris: ["https://claude.ai/cb"] };

test("checkAuthorizeRequest accepts a well-formed request", () => {
  const r = checkAuthorizeRequest(authParams(), client, PUBLIC_URL);
  expect(r.ok).toBe(true);
});

test("checkAuthorizeRequest rejects unknown client, bad redirect, non-S256, missing challenge, bad resource", () => {
  expect(checkAuthorizeRequest(authParams(), null, PUBLIC_URL).ok).toBe(false);
  expect(checkAuthorizeRequest(authParams({ redirect_uri: "https://evil/cb" }), client, PUBLIC_URL).ok).toBe(false);
  expect(checkAuthorizeRequest(authParams({ code_challenge_method: "plain" }), client, PUBLIC_URL).ok).toBe(false);
  expect(checkAuthorizeRequest(authParams({ code_challenge: "" }), client, PUBLIC_URL).ok).toBe(false);
  expect(checkAuthorizeRequest(authParams({ response_type: "token" }), client, PUBLIC_URL).ok).toBe(false);
  expect(checkAuthorizeRequest(authParams({ resource: "https://evil" }), client, PUBLIC_URL).ok).toBe(false);
});

// --- metadata documents advertise the mandatory bits ---

test("AS metadata advertises S256 (mandatory) + the three endpoints", () => {
  const m = asMetadata(PUBLIC_URL);
  expect(m.code_challenge_methods_supported).toEqual(["S256"]);
  expect(m.authorization_endpoint).toBe(`${PUBLIC_URL}/oauth/authorize`);
  expect(m.token_endpoint).toBe(`${PUBLIC_URL}/oauth/token`);
  expect(m.registration_endpoint).toBe(`${PUBLIC_URL}/oauth/register`);
});

test("protected-resource metadata names us as our own authorization server", () => {
  const m = protectedResourceMetadata(PUBLIC_URL);
  expect(m.resource).toBe(PUBLIC_URL);
  expect(m.authorization_servers).toEqual([PUBLIC_URL]);
});

// --- Store: one-shot code + multi connector tokens ---

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

test("OAuth code is ONE-SHOT: a second redeem of the same code returns null", () => {
  const acct = store.findOrCreateAccount("sub-x").account;
  store.registerOAuthClient({ clientId: "c1", redirectUris: ["https://claude.ai/cb"] });
  store.putOAuthCode("the-code", {
    client_id: "c1",
    user_id: acct.user_id,
    code_challenge: "ch",
    redirect_uri: "https://claude.ai/cb",
    resource: PUBLIC_URL,
    expiresAtMs: 10_000,
  });
  const first = store.takeOAuthCode("the-code", 5_000);
  expect(first?.user_id).toBe(acct.user_id);
  const second = store.takeOAuthCode("the-code", 5_000); // replay
  expect(second).toBeNull();
});

test("OAuth code expires: redeeming after expires_at returns null (and is consumed)", () => {
  const acct = store.findOrCreateAccount("sub-y").account;
  store.putOAuthCode("c", {
    client_id: "c1",
    user_id: acct.user_id,
    code_challenge: "ch",
    redirect_uri: "r",
    resource: null,
    expiresAtMs: 1_000,
  });
  expect(store.takeOAuthCode("c", 2_000)).toBeNull(); // now > expiry
});

test("a per-client connector token resolves to its account; many tokens → same account", () => {
  const acct = store.findOrCreateAccount("sub-z").account;
  const t1 = store.issueConnectorToken(acct.user_id, "Cowork desktop");
  const t2 = store.issueConnectorToken(acct.user_id, "phone");
  expect(store.resolveConnectorToken(t1)).toBe(acct.user_id);
  expect(store.resolveConnectorToken(t2)).toBe(acct.user_id);
  expect(t1).not.toBe(t2); // each Claude gets its OWN token
  expect(store.resolveConnectorToken("msk_bogus")).toBeNull();
});

test("issuing a connector token for a missing account throws", () => {
  expect(() => store.issueConnectorToken("nobody")).toThrow();
});

test("delete-everything also removes the per-client connector tokens", () => {
  const acct = store.findOrCreateAccount("sub-del").account;
  const t = store.issueConnectorToken(acct.user_id);
  expect(store.resolveConnectorToken(t)).toBe(acct.user_id);
  store.deleteAccount(acct.user_id);
  expect(store.resolveConnectorToken(t)).toBeNull();
});
