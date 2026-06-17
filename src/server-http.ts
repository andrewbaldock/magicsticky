#!/usr/bin/env bun
// Magic Sticky — Phase 2 HTTP entrypoint. Boots the Hono app over Bun.serve.
//
// Env:
//   MAGICSTICKY_DB     path to the SQLite file (default ./magicsticky.db; on Fly = volume path)
//   MAGICSTICKY_TOKEN  the static connector bearer token (single-user MVP)
//   MAGICSTICKY_USER   the userId that token maps to (default "andrew")
//   PORT               listen port (default 3000)

import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Store } from "./db.ts";
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
      return { sub: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined };
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
const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const googleClientId = process.env.GOOGLE_CLIENT_ID;

if (!token) {
  console.error("Refusing to start: set MAGICSTICKY_TOKEN (the connector bearer token).");
  process.exit(1);
}

const store = new Store(dbPath);

// Single-user MVP: exactly one valid token → one user. The resolver is the single auth seam for
// when multi-user lands.
const app = createApp({
  store,
  resolveToken: (t) => (tokenMatches(t, token) ? userId : null),
  verifyGoogleToken: googleClientId ? makeGoogleVerifier(googleClientId) : undefined,
});

console.log(
  `magicsticky HTTP on :${port} (db: ${dbPath}; google sign-in: ${googleClientId ? "on" : "off"})`,
);
export default { port, fetch: app.fetch };
