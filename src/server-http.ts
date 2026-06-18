#!/usr/bin/env bun
// Magic Sticky — Phase 2 HTTP entrypoint. Boots the Hono app over Bun.serve.
//
// Env:
//   MAGICSTICKY_DB     path to the SQLite file (default ./magicsticky.db; on Fly = volume path)
//   MAGICSTICKY_TOKEN  the static connector bearer token (single-user MVP)
//   MAGICSTICKY_USER   the userId that token maps to (default "andrew")
//   PORT               listen port (default 3001 locally; Fly sets 8080)

import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Store } from "./db.ts";
import { cipherFromEnv } from "./crypto.ts";
import { makeSessionSigner } from "./session.ts";
import { createApp, type GoogleIdentity } from "./app.ts";

// Real Google ID-token verifier: validates the JWT signature against Google's published certs and
// checks issuer + audience (our client id). Only wired when GOOGLE_CLIENT_ID is set; otherwise the
// /auth/google route returns 501. The app-level seam keeps this swappable + testable.
function makeGoogleVerifier(clientId: string): (credential: string) => Promise<GoogleIdentity | null> {
  const jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
  return async (credential) => {
    try {
      const { payload } = await jwtVerify(credential, jwks, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: clientId,
      });
      if (!payload.sub) return null;
      // Don't trust an unverified-email Google account.
      if (payload.email_verified !== true) return null;
      return {
        sub: payload.sub,
        email: typeof payload.email === "string" ? payload.email : undefined,
        email_verified: true,
      };
    } catch {
      return null; // bad signature / expired / wrong audience
    }
  };
}

// Constant-time token compare. Hash both sides first so the compare is fixed-length (dodges the
// timingSafeEqual equal-length-throw and the length side-channel). It's the one secret guarding
// Andrew's data — constant-time is the standard default for secret comparison; ~free.
function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const dbPath = process.env.MAGICSTICKY_DB ?? "./magicsticky.db";
const token = process.env.MAGICSTICKY_TOKEN;
const userId = process.env.MAGICSTICKY_USER ?? "andrew";
// Local default 3001 (3000 is Orion's API; prod/Fly sets PORT=8080 via fly.toml).
const port = process.env.PORT ? Number(process.env.PORT) : 3001;
const googleClientId = process.env.GOOGLE_CLIENT_ID;
// Who may sign in (comma-separated). Single-user/demo allowlist — without it, sign-in is deny-all.
const allowedSubs = (process.env.MAGICSTICKY_ALLOWED_SUBS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const allowedEmails = (process.env.MAGICSTICKY_ALLOWED_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

if (!token) {
  console.error("Refusing to start: set MAGICSTICKY_TOKEN (the connector bearer token).");
  process.exit(1);
}

// App-layer encryption of sticky text at rest (SPEC §11). Keys from MAGICSTICKY_KEYS as
// "id:hexkey,..." (first = primary). In production, REFUSE to boot without keys — a misconfigured
// deploy must never silently store this sensitive data as plaintext. In dev, plaintext + a warning.
const cipher = cipherFromEnv(process.env.MAGICSTICKY_KEYS);
if (!cipher) {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to start in production: set MAGICSTICKY_KEYS (encryption at rest).");
    process.exit(1);
  }
  console.warn("MAGICSTICKY_KEYS not set — sticky text stored as PLAINTEXT at rest (dev only).");
}

const store = new Store(dbPath, cipher);

// Single-user MVP: exactly one valid token → one user. The resolver is the single auth seam for
// when multi-user lands.
const sessionSecret = process.env.MAGICSTICKY_SESSION_SECRET;
if (googleClientId && !sessionSecret) {
  console.warn("GOOGLE_CLIENT_ID set but MAGICSTICKY_SESSION_SECRET is not — /api sign-in disabled.");
}

const app = createApp({
  store,
  resolveToken: (t) => (tokenMatches(t, token) ? userId : null),
  verifyGoogleToken: googleClientId ? makeGoogleVerifier(googleClientId) : undefined,
  isAllowed: (id) =>
    allowedSubs.includes(id.sub) ||
    (!!id.email && allowedEmails.includes(id.email.toLowerCase())),
  session: sessionSecret ? makeSessionSigner(sessionSecret) : undefined,
  secureCookie: process.env.NODE_ENV === "production",
  // Serve the built UI from this origin when MAGICSTICKY_WEB_DIST points at web/dist (prod). In dev
  // we run Vite separately on :5180; leave it unset.
  webDist: process.env.MAGICSTICKY_WEB_DIST,
});

console.log(
  `magicsticky HTTP on :${port} (db: ${dbPath}; google sign-in: ${googleClientId ? "on" : "off"})`,
);
export default { port, fetch: app.fetch };
