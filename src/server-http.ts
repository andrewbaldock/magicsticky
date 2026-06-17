#!/usr/bin/env bun
// Magic Sticky — Phase 2 HTTP entrypoint. Boots the Hono app over Bun.serve.
//
// Env:
//   MAGICSTICKY_DB     path to the SQLite file (default ./magicsticky.db; on Fly = volume path)
//   MAGICSTICKY_TOKEN  the static connector bearer token (single-user MVP)
//   MAGICSTICKY_USER   the userId that token maps to (default "andrew")
//   PORT               listen port (default 3000)

import { Store } from "./db.ts";
import { createApp } from "./app.ts";

const dbPath = process.env.MAGICSTICKY_DB ?? "./magicsticky.db";
const token = process.env.MAGICSTICKY_TOKEN;
const userId = process.env.MAGICSTICKY_USER ?? "andrew";
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

if (!token) {
  console.error("Refusing to start: set MAGICSTICKY_TOKEN (the connector bearer token).");
  process.exit(1);
}

const store = new Store(dbPath);

// Single-user MVP: exactly one valid token → one user. Constant-time-ish compare is overkill for
// one local secret, but keep the resolver as the single auth seam for when multi-user lands.
const app = createApp({
  store,
  resolveToken: (t) => (t === token ? userId : null),
});

console.log(`magicsticky HTTP on :${port} (db: ${dbPath})`);
export default { port, fetch: app.fetch };
