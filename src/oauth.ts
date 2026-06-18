// Magic Sticky — minimal OAuth 2.1 Authorization Server, the part that's pure logic (no HTTP, no
// DB). The routes live in app.ts and lean on these helpers + the Store's oauth_* tables.
//
// WHY this exists: the desktop / Cowork / phone "Add custom connector" dialog has no static-header
// field — it only does OAuth. So to honor the product's whole point ("ALL CLAUDES CAN SHARE THIS
// PROMPT"), Magic Sticky must BE an OAuth AS. Google authenticates the human; this AS mints (via the
// Store) the per-client connector token that /mcp already understands. The OAuth access_token IS a
// `msk_…` connector token — no JWTs, no refresh tokens. Smallest correct surface.
//
// Spec: MCP authorization 2025-11-25 — PKCE (S256) MANDATORY, RFC 8707 resource indicators required,
// RFC 9728 protected-resource metadata, RFC 8414 AS metadata, RFC 7591 DCR.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const AUTH_CODE_TTL_MS = 60_000; // codes are one-shot + short-lived (browser-speed redeem)
export const OAUTH_SCOPE = "mcp"; // single scope — the connector reads/writes the shared sticky

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

// PKCE S256: the challenge is base64url(SHA-256(verifier)). We only support S256 (the spec says use
// it whenever technically capable; "plain" is not advertised, so clients must send S256).
export function computeS256Challenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

// Constant-time compare of the recomputed challenge vs the stored one. Equal-length guard avoids
// timingSafeEqual throwing; mismatched lengths can't be equal anyway.
export function verifyPkceS256(verifier: string, storedChallenge: string): boolean {
  if (!verifier || !storedChallenge) return false;
  const computed = computeS256Challenge(verifier);
  if (computed.length !== storedChallenge.length) return false;
  return timingSafeEqual(Buffer.from(computed), Buffer.from(storedChallenge));
}

// Opaque, unguessable tokens for codes and client ids.
export function randomCode(): string {
  return b64url(randomBytes(32));
}
export function randomClientId(): string {
  return `msc_${b64url(randomBytes(16))}`;
}

// RFC 8707: the `resource` the client requests a token for MUST identify THIS server. We compare
// against our canonical public URL, tolerating a trailing slash and an optional /mcp path (clients
// variously send the origin or the exact MCP endpoint). Returns true if it names us.
export function resourceMatches(resource: string | null | undefined, publicUrl: string): boolean {
  if (!resource) return false;
  const norm = (u: string) => u.replace(/\/+$/, "").replace(/\/mcp$/, "");
  return norm(resource) === norm(publicUrl);
}

// Validate a redirect_uri against a client's registered set with EXACT string match (no prefix/
// substring matching — that's an open-redirect foot-gun). Loopback (127.0.0.1 / localhost) and
// custom-scheme URIs are how native MCP clients receive the code; we don't special-case them, we
// just require they were registered (DCR records whatever the client declared).
export function redirectUriAllowed(redirectUri: string, registered: string[]): boolean {
  return registered.includes(redirectUri);
}

// Verify a presented client_secret against the stored hash (constant-time). A public PKCE client has
// no secret (storedHash null) → only valid when none is presented. Used at the token endpoint when a
// confidential client (pre-registered with a secret) authenticates.
export function clientSecretMatches(presented: string | undefined, storedHash: string | null): boolean {
  if (storedHash === null) return !presented; // public client: must NOT present a secret
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Validation result for the authorize request — either an error to render, or the vetted params.
export type AuthorizeCheck =
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
      state: string | null;
      resource: string | null;
    };

// Validate /oauth/authorize query params BEFORE we know who the human is. Confirms the client exists,
// the redirect_uri is registered, PKCE is S256, response_type=code, and (if sent) the resource names
// us. On a bad client/redirect we MUST NOT redirect (could leak a code to an attacker) — hence the
// distinct `status`/`error` for those vs everything else, which app.ts redirects as an OAuth error.
export function checkAuthorizeRequest(
  params: URLSearchParams,
  client: { client_id: string; redirect_uris: string[] } | null,
  publicUrl: string,
): AuthorizeCheck {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!client || client.client_id !== clientId) {
    return { ok: false, status: 400, error: "unknown client_id" };
  }
  if (!redirectUri || !redirectUriAllowed(redirectUri, client.redirect_uris)) {
    return { ok: false, status: 400, error: "redirect_uri not registered for this client" };
  }
  // From here a problem CAN be redirected back to the (validated) redirect_uri as ?error=… —
  // but we still just refuse, returning 400, to keep the surface tiny. app.ts decides presentation.
  if (params.get("response_type") !== "code") {
    return { ok: false, status: 400, error: "unsupported_response_type (only 'code')" };
  }
  if ((params.get("code_challenge_method") ?? "") !== "S256") {
    return { ok: false, status: 400, error: "code_challenge_method must be S256" };
  }
  const codeChallenge = params.get("code_challenge") ?? "";
  if (!codeChallenge) return { ok: false, status: 400, error: "code_challenge required (PKCE)" };
  const resource = params.get("resource");
  if (resource && !resourceMatches(resource, publicUrl)) {
    return { ok: false, status: 400, error: "resource does not identify this server" };
  }
  return {
    ok: true,
    clientId,
    redirectUri,
    codeChallenge,
    state: params.get("state"),
    resource,
  };
}

// The AS metadata document (RFC 8414) advertised at /.well-known/oauth-authorization-server.
export function asMetadata(publicUrl: string) {
  const base = publicUrl.replace(/\/+$/, "");
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    // MANDATORY: clients refuse to proceed if this is absent (no way to discover PKCE support).
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: [OAUTH_SCOPE],
  };
}

// The protected-resource metadata document (RFC 9728) at /.well-known/oauth-protected-resource.
// Points the client at us as our own authorization server.
export function protectedResourceMetadata(publicUrl: string) {
  const base = publicUrl.replace(/\/+$/, "");
  return {
    resource: base,
    authorization_servers: [base],
    scopes_supported: [OAUTH_SCOPE],
  };
}
