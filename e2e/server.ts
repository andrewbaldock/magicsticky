// TEST-ONLY server for Playwright. Boots the REAL Hono app + the REAL built UI (web/dist), but
// stubs Google sign-in so the browser test never has to drive Google's own screen. This file is
// NEVER shipped — production uses src/server-http.ts, which knows nothing about any of this.
//
// The stub: any credential of the form "e2e:<email>" signs that email in (allowlisted), so a test
// can become a fresh user deterministically. Real token verification is untouched in prod.

import { join } from "node:path";
import { Store } from "../src/db.ts";
import { makeSessionSigner } from "../src/session.ts";
import { createApp } from "../src/app.ts";

const port = Number(process.env.E2E_PORT ?? 3199);
const webDist = join(import.meta.dir, "..", "web", "dist");

const store = new Store(":memory:"); // ephemeral; fresh per test run

const app = createApp({
  store,
  resolveToken: () => null, // no connector bootstrap token in E2E
  verifyGoogleToken: async (cred) => {
    const m = /^e2e:(.+)$/.exec(cred);
    return m ? { sub: `sub-${m[1]}`, email: m[1], email_verified: true } : null;
  },
  isAllowed: () => true, // allowlist is unit-tested elsewhere; E2E focuses on the UI flow
  session: makeSessionSigner("e2e-secret"),
  secureCookie: false, // http in tests
  webDist, // serve the built React app from this origin
});

console.log(`[e2e] magicsticky test server on :${port} (serving ${webDist})`);
export default { port, fetch: app.fetch };
