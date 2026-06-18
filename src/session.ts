// Magic Sticky — human web session. After Google sign-in we issue a signed, httpOnly cookie so the
// browser is authenticated to /api without re-doing Google each request. This is the HUMAN path;
// the Claude connector uses a separate static bearer token (see app.ts /mcp).
//
// The token is `userId.expiry.hmac` (HMAC-SHA256 over "userId.expiry" with a server secret). It's
// stateless (no session table) and tamper-evident; rotate the secret to invalidate all sessions.

import { createHmac, timingSafeEqual } from "node:crypto";

const SEP = ".";
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionSigner {
  issue(userId: string): string;
  verify(token: string): string | null; // returns userId or null
}

export function makeSessionSigner(secret: string, ttlMs = DEFAULT_TTL_MS): SessionSigner {
  if (!secret) throw new Error("session secret required");
  const sign = (data: string) => createHmac("sha256", secret).update(data).digest("base64url");

  return {
    issue(userId) {
      const expiry = String(nowMs() + ttlMs);
      const data = `${userId}${SEP}${expiry}`;
      return `${data}${SEP}${sign(data)}`;
    },
    verify(token) {
      if (!token) return null;
      // Parse the mac from the RIGHT (last dot) and expiry from the next-to-last, so a userId
      // containing dots can't confuse the split. data = everything before the mac = "userId.expiry".
      const macAt = token.lastIndexOf(SEP);
      if (macAt <= 0) return null;
      const expAt = token.lastIndexOf(SEP, macAt - 1);
      if (expAt <= 0) return null;
      const userId = token.slice(0, expAt);
      const expiry = token.slice(expAt + 1, macAt);
      const mac = token.slice(macAt + 1);
      const data = `${userId}${SEP}${expiry}`;
      const expected = sign(data);
      // constant-time compare; equal-length guard avoids timingSafeEqual throwing
      if (mac.length !== expected.length) return null;
      if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
      if (!/^\d+$/.test(expiry) || Number(expiry) < nowMs()) return null; // expired
      return userId;
    },
  };
}

function nowMs(): number {
  return new Date().getTime();
}
