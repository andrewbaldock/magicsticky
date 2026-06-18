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
const session = makeSessionSigner("e2e-secret");

const app = createApp({
  store,
  resolveToken: () => null, // no connector bootstrap token in E2E
  verifyGoogleToken: async (cred) => {
    const m = /^e2e:(.+)$/.exec(cred);
    return m ? { sub: `sub-${m[1]}`, email: m[1], email_verified: true } : null;
  },
  isAllowed: () => true, // allowlist is unit-tested elsewhere; E2E focuses on the UI flow
  session,
  secureCookie: false, // http in tests
  webDist, // serve the built React app from this origin
});

// VISUAL-ONLY bypass: GET /__demo seeds a signed-in session with sample content and redirects to the
// workspace, so eyeballing the UI is a single `goto('/__demo')` — no Google/sign-in dance. Test-only
// (this file never ships); wrapped so it runs BEFORE the real app and only for this one path.
const SAMPLE = `# Andrew — Master TODO (the one list)

Frictionless source of truth that Claude edits directly (no permissions, no browser).

## CURRENT FOCUS
Job-hunt orchestration across Claude sessions.

## PRIORITIES (ranked — top = do next)
1. [ ] Do the Wellfound AI interview. Cue cards already made.
2. [ ] Apply to 3 more jobs today.
3. [ ] Gym tonight — clear head for tomorrow's interview.

## DONE
- Built the magic sticky connector — any Claude can read/write.`;

const fetchHandler = (req: Request) => {
  const url = new URL(req.url);
  if (url.pathname === "/__demo") {
    const { account } = store.findOrCreateAccount(`sub-demo`, { email: "demo@example.com", draft: SAMPLE });
    const cookie = `ms_session=${session.issue(account.user_id)}; Path=/; HttpOnly; SameSite=Lax`;
    return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": cookie } });
  }
  return app.fetch(req);
};

console.log(`[e2e] magicsticky test server on :${port} (serving ${webDist})  — visual bypass: /__demo`);
export default { port, fetch: fetchHandler };
