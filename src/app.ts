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

export interface AppOptions {
  store: Store;
  // Maps a bearer token -> userId. Single-user MVP: one token. Returns null for an unknown token.
  resolveToken: (token: string) => string | null;
}

type Variables = { userId: string };

export function createApp({ store, resolveToken }: AppOptions): Hono<{ Variables: Variables }> {
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
    return transport.handleRequest(c.req.raw);
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // Human-facing routes (landing sticky, /app, /export, /delete-everything) land in later steps.
  app.get("/", (c) => c.text("Magic Sticky — coming soon."));

  return app;
}
