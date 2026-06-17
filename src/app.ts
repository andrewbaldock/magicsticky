// Magic Sticky — Phase 2 HTTP app (Hono). One origin serves /mcp (+ later the PWA + /api).
//
// The Claude connector authenticates with a static per-account BEARER TOKEN (single-user MVP):
// `Authorization: Bearer <token>`. The token resolves to a userId; full OAuth is a later concern.
// Human (web) auth is Google sign-in, added in a later step — not here.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Store } from "./db.ts";
import { buildMcpServer } from "./mcp.ts";

// The verified identity from a Google sign-in (the OIDC claims we care about).
export interface GoogleIdentity {
  sub: string; // stable Google account id
  email?: string;
}

export interface AppOptions {
  store: Store;
  // Maps a bearer token -> userId. Single-user MVP: one token. Returns null for an unknown token.
  resolveToken: (token: string) => string | null;
  // Verify a Google ID token / credential and return its identity, or null if invalid. This is a
  // seam: the real implementation calls Google's tokeninfo / verifies the JWT with Google's certs.
  // Kept injectable so the account + seeding logic is testable without live Google credentials.
  verifyGoogleToken?: (credential: string) => Promise<GoogleIdentity | null>;
}

type Variables = { userId: string };

export function createApp({
  store,
  resolveToken,
  verifyGoogleToken,
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

  // Bearer-token auth on the connector. The userId rides on the context for the handler.
  app.use("/mcp", async (c, next) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const userId = token ? resolveToken(token) : null;
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

    const { account, created } = store.findOrCreateAccount(identity.sub, {
      email: identity.email,
      draft: body.draft,
    });
    // NOTE: this returns the userId for now; a real session cookie / web token lands with the PWA
    // (step 5). The connector still uses the static bearer token, not this.
    return c.json({ user_id: account.user_id, created });
  });

  // Human-facing routes (landing sticky, /app, /export, /delete-everything) land in later steps.
  app.get("/", (c) => c.text("Magic Sticky — coming soon."));

  return app;
}
