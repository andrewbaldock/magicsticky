// Magic Sticky — Phase 2 HTTP app (Hono). One origin serves /mcp (+ later the PWA + /api).
//
// The Claude connector authenticates with a static per-account BEARER TOKEN (single-user MVP):
// `Authorization: Bearer <token>`. The token resolves to a userId; full OAuth is a later concern.
// Human (web) auth is Google sign-in, added in a later step — not here.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { serveStatic } from "hono/bun";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Store, VersionConflictError, TooLongError, NotFoundError } from "./db.ts";
import { buildMcpServer } from "./mcp.ts";
import type { SessionSigner } from "./session.ts";

const SESSION_COOKIE = "ms_session";

// The verified identity from a Google sign-in (the OIDC claims we care about).
export interface GoogleIdentity {
  sub: string; // stable Google account id
  email?: string;
  email_verified?: boolean;
}

export interface AppOptions {
  store: Store;
  // Maps a bearer token -> userId. Single-user MVP: one token. Returns null for an unknown token.
  resolveToken: (token: string) => string | null;
  // Verify a Google ID token / credential and return its identity, or null if invalid. This is a
  // seam: the real implementation calls Google's tokeninfo / verifies the JWT with Google's certs.
  // Kept injectable so the account + seeding logic is testable without live Google credentials.
  verifyGoogleToken?: (credential: string) => Promise<GoogleIdentity | null>;
  // Gate on WHO may sign in. Single-user/demo: an explicit allowlist. Without this, any valid Google
  // account could mint an account in the one DB — reintroducing multi-tenancy we deliberately don't
  // have. Return false → 403, BEFORE any account is created. Defaults to deny-all if omitted.
  isAllowed?: (identity: GoogleIdentity) => boolean;
  // Signs/verifies the human web session cookie (issued on Google sign-in). If omitted, the human
  // /api and the cookie issuance are disabled (the MCP connector path is unaffected).
  session?: SessionSigner;
  // Set Secure on the session cookie (true in prod over HTTPS; false for http://localhost dev).
  secureCookie?: boolean;
  // Absolute path to the built web app (web/dist) to serve from this origin in prod. Omit in dev
  // (Vite serves the UI) and in tests.
  webDist?: string;
}

type Variables = { userId: string };

export function createApp({
  store,
  resolveToken,
  verifyGoogleToken,
  isAllowed = () => false,
  session,
  secureCookie = true,
  webDist,
}: AppOptions): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  // CORS for MCP clients (the connector handshake needs these headers exposed).
  app.use(
    "/mcp",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "mcp-session-id", "Last-Event-ID", "mcp-protocol-version"],
      exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
    }),
  );

  // Bearer-token auth on the connector, two-tier: (a) the env bootstrap token (Andrew's existing
  // connector → MAGICSTICKY_USER), else (b) a per-user connector token resolved by hash to its
  // owning account. This is what gives each human their OWN Claude access to their OWN stickies.
  app.use("/mcp", async (c, next) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const userId = token ? (resolveToken(token) ?? store.resolveConnectorToken(token)) : null;
    if (!userId) {
      return c.json({ error: "unauthorized: provide a valid Bearer token" }, 401);
    }
    c.set("userId", userId);
    await next();
  });

  // Stateless MCP: a fresh transport + server per request (the SDK's recommended Web-Standard
  // pattern). Stateless sidesteps in-memory session state, so horizontal scale is a non-issue and
  // our 4 simple request/response tools don't need server-initiated streams.
  app.all("/mcp", async (c) => {
    const userId = c.get("userId");
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer(store, userId);
    await server.connect(transport);
    // Stateless: the per-request transport + server are dropped after the response and GC'd. In
    // stateless mode the web-standard transport holds no cross-request timers/listeners, so for our
    // non-streaming JSON tools no explicit close is needed. Revisit if a streaming tool is added.
    return transport.handleRequest(c.req.raw);
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // Google sign-in (human path). Body: { credential, draft? } where `credential` is the Google ID
  // token from the browser and `draft` is the optional pre-auth localStorage sticky text. On first
  // sign-in this creates the account and seeds sticky 1 (draft + onboarding blurb, marked shared);
  // a returning user just gets their account back (no re-seeding — the blurb never re-injects).
  app.post("/auth/google", async (c) => {
    if (!verifyGoogleToken) return c.json({ error: "google sign-in not configured" }, 501);
    let body: { credential?: string; draft?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "expected JSON body" }, 400);
    }
    if (!body.credential) return c.json({ error: "missing credential" }, 400);

    const identity = await verifyGoogleToken(body.credential);
    if (!identity) return c.json({ error: "invalid Google credential" }, 401);

    // Allowlist gate: reject anyone not explicitly permitted BEFORE creating an account. This is
    // what keeps the single-user/demo app from becoming an open SaaS in one DB file.
    if (!isAllowed(identity)) return c.json({ error: "this account is not permitted" }, 403);

    const { account, created } = store.findOrCreateAccount(identity.sub, {
      email: identity.email,
      draft: body.draft,
    });
    // Issue the human session cookie (httpOnly so JS can't read it; SameSite=Lax). The browser is
    // now authenticated to /api; it never sees the connector bearer token or the internal user_id.
    if (session) {
      setCookie(c, SESSION_COOKIE, session.issue(account.user_id), {
        httpOnly: true,
        secure: secureCookie,
        sameSite: "Lax",
        path: "/",
        maxAge: 30 * 24 * 60 * 60,
      });
    }
    return c.json({ ok: true, created });
  });

  // --- Human web API (signed-in session, NOT the connector bearer). The browser talks to these. ---

  app.use("/api/*", async (c, next) => {
    if (!session) return c.json({ error: "sessions not configured" }, 501);
    const userId = session.verify(getCookie(c, SESSION_COOKIE) ?? "");
    // Valid signature is not enough — the account must still exist. A cookie must never outlive its
    // account (e.g. after delete-everything); clear it and 401 if the account is gone.
    if (!userId || !store.hasAccount(userId)) {
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ error: "not signed in" }, 401);
    }
    c.set("userId", userId);
    await next();
  });

  // Sign out: clear the session cookie. Stateless tokens can't be server-revoked, but clearing the
  // cookie ends the session on this device (the point of a logout button on a shared browser).
  app.post("/api/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // List the stack WITH derived titles (human path — may see own notes' titles; the MCP
  // list_stickies stays metadata-only).
  app.get("/api/stickies", (c) => c.json({ stickies: store.listWithTitles(c.get("userId")) }));

  // Full text of one sticky (+ version for optimistic save).
  app.get("/api/stickies/:id", (c) => {
    const s = store.get(c.get("userId"), c.req.param("id"));
    if (!s) return c.json({ error: "not found" }, 404);
    return c.json({ id: s.id, text: s.text, version: s.version, char_count: s.char_count, is_shared: s.is_shared });
  });

  // Save (overwrite) a sticky — same version CAS as the MCP write path (store-level guard).
  app.put("/api/stickies/:id", async (c) => {
    const userId = c.get("userId");
    let body: { text?: string; version?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "expected JSON body" }, 400);
    }
    if (typeof body.text !== "string" || typeof body.version !== "number") {
      return c.json({ error: "text (string) and version (number) required" }, 400);
    }
    try {
      const s = store.writeShared(userId, c.req.param("id"), body.text, body.version);
      return c.json({ id: s.id, text: s.text, version: s.version, char_count: s.char_count });
    } catch (e) {
      if (e instanceof VersionConflictError) return c.json({ error: "version_conflict", current: e.actual }, 409);
      if (e instanceof TooLongError) return c.json({ error: "too_long", limit: e.length }, 413);
      if (e instanceof NotFoundError) return c.json({ error: "not found" }, 404);
      throw e;
    }
  });

  // Create a new sticky in the stack (human action; not an MCP tool).
  app.post("/api/stickies", (c) => {
    const s = store.create(c.get("userId"), "");
    return c.json({ id: s.id, version: s.version }, 201);
  });

  // Flip which sticky is the shared prompt.
  app.post("/api/stickies/:id/share", (c) => {
    try {
      const s = store.setShared(c.get("userId"), c.req.param("id"));
      return c.json({ id: s.id, is_shared: s.is_shared });
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: "not found" }, 404);
      throw e;
    }
  });

  // Undo the last overwrite of the shared sticky (1-deep).
  app.post("/api/stickies/undo", (c) => {
    const s = store.undoShared(c.get("userId"));
    if (!s) return c.json({ error: "nothing to undo" }, 409);
    return c.json({ id: s.id, text: s.text, version: s.version });
  });

  // Offline catch-up: append a note captured while offline. kind "text" → lowest non-shared sticky
  // (auto-created if none); "claude" → the shared sticky. Append-only, below a timestamped divider —
  // conflict-free, so it never clobbers edits made elsewhere while you were offline.
  app.post("/api/catch-up", async (c) => {
    let body: { kind?: string; note?: string; stamp?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "expected JSON body" }, 400);
    }
    if ((body.kind !== "text" && body.kind !== "claude") || typeof body.note !== "string" || !body.note) {
      return c.json({ error: 'kind ("text"|"claude") and a non-empty note are required' }, 400);
    }
    const stamp = typeof body.stamp === "string" && body.stamp ? body.stamp : new Date().toISOString();
    try {
      const s = store.appendCatchUp(c.get("userId"), body.kind, body.note, stamp);
      return c.json({ id: s.id, char_count: s.char_count, is_shared: s.is_shared });
    } catch (e) {
      if (e instanceof TooLongError) return c.json({ error: "too_long", limit: e.length }, 413);
      if (e instanceof NotFoundError) return c.json({ error: "not found" }, 404);
      throw e;
    }
  });

  // "Connect a Claude": generate (or rotate) this user's connector token. The RAW token is returned
  // ONCE — only its hash is stored. The UI reveals it once for copy, then it's unrecoverable.
  app.post("/api/connector-token", (c) => {
    const token = store.generateConnectorToken(c.get("userId"));
    return c.json({ token });
  });

  // Export: full plaintext JSON dump of the user's own data (SPEC §11 "ship from day one"). Behind
  // the session, scoped to the user; the server decrypts (it's the owner's data behind their auth).
  app.get("/api/export", (c) => {
    const data = store.exportAccount(c.get("userId"));
    c.header("Content-Disposition", 'attachment; filename="magicsticky-export.json"');
    return c.json(data);
  });

  // Delete everything: irreversible erasure of the account + all stickies. POST + a typed
  // confirmation token (never a GET — a prefetch/scanner must not be able to trigger it). Clears
  // the session after.
  app.post("/api/delete-everything", async (c) => {
    let body: { confirm?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "expected JSON body" }, 400);
    }
    if (body.confirm !== "DELETE") {
      return c.json({ error: 'confirmation required: { "confirm": "DELETE" }' }, 400);
    }
    store.deleteAccount(c.get("userId"));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // Serve the built React app (web/dist) from the same origin in prod. `webDist` is the built dir;
  // omitted in dev (Vite serves the UI on :5180 and proxies /api+/auth here) and in tests.
  if (webDist) {
    app.use("/assets/*", serveStatic({ root: webDist }));
    // Root-level static files (PWA manifest, icons, favicon) — these live at "/" not "/assets", so
    // they'd otherwise fall through to the SPA and return index.html. Serve them explicitly with
    // correct content-types so the PWA installs and icons load.
    const rootFiles: Record<string, string> = {
      "/manifest.webmanifest": "application/manifest+json",
      "/sw.js": "text/javascript",
      "/favicon.svg": "image/svg+xml",
      "/icon.svg": "image/svg+xml",
      "/icon-192.png": "image/png",
      "/icon-512.png": "image/png",
      "/icon-180.png": "image/png",
    };
    for (const [path, type] of Object.entries(rootFiles)) {
      app.get(path, async (c) => {
        const f = Bun.file(`${webDist}${path}`);
        if (!(await f.exists())) return c.notFound();
        c.header("Content-Type", type);
        return c.body(await f.arrayBuffer());
      });
    }
    // SPA fallback: any non-API/MCP GET returns index.html so client routing works. Read the file
    // directly (robust across Hono serveStatic path-resolution quirks) and serve it as HTML.
    const indexHtml = `${webDist}/index.html`;
    app.get("*", async (c) => {
      const file = Bun.file(indexHtml);
      if (!(await file.exists())) return c.text("UI not built (run: bun run build:web)", 500);
      return c.html(await file.text());
    });
  } else {
    app.get("/", (c) => c.text("Magic Sticky — UI served by Vite in dev (:5180) or web/dist in prod."));
  }

  return app;
}
