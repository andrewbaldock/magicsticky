# magicsticky

Hosted sticky notes — for humans AND as a shared prompt any Claude can read.

You keep a small stack of plain-text sticky notes. **Exactly one** is the **shared prompt**: the
note every Claude you connect reads (and can update) over MCP, so each AI you talk to inherits your
current context. You reach the notes from a phone-first web app; a Claude reaches them through one
connector token. The whole product is the discipline of staying a sticky note.

## Architecture
![magicsticky architecture](./docs/architecture.drawio.svg)

The diagram is an editable [draw.io](https://app.diagrams.net) file — open
[`docs/architecture.drawio.svg`](./docs/architecture.drawio.svg) in the draw.io desktop app, the
VS Code extension, or app.diagrams.net to edit it.

## Model
- A **sticky** is one free-text blob, ≤10,000 chars. No folders, no rich text, no item lists.
- You hold a small **stack** (~10). One is flagged the **shared prompt** (a "lozenge" in the UI).
- **Humans** sign in with Google (web app); **Claude** authenticates with a per-account bearer
  **connector token** generated in the app ("Connect a Claude").
- The 4 MCP tools: `whoami` (read the shared sticky), `write` (replace it, with an optimistic
  `version` to avoid clobbering), `list_stickies` (metadata only — never the other notes' text),
  `set_shared` (flip which note is shared).

## Stack
Bun + Hono + `bun:sqlite` (one Fly app) · React 19 + Vite frontend · MCP over Streamable HTTP ·
AES-256-GCM encryption at rest · AGPL-3.0.

## Run it (dev)
```sh
bun install
cp .env.example .env     # set MAGICSTICKY_TOKEN, _SESSION_SECRET, _KEYS, _ALLOWED_EMAILS
bun run start            # the Bun/Hono server on :3000 (API + /mcp)
bun run dev:web          # the Vite dev server on :5180 (proxies /api + /auth to :3000)
```
Prod build: `bun run build:web` then serve with `MAGICSTICKY_WEB_DIST=web/dist` set.

## Test
```sh
bun run test       # backend unit/integration (bun:test)
bun run test:e2e   # Playwright UI E2E on iPhone / Pixel / Desktop
bun run typecheck  # backend + web/
```

## Register the connector in a Claude
Sign in to the web app → **Connect a Claude** → generate a token → add a custom MCP connector
pointing at `https://<host>/mcp` with `Authorization: Bearer <token>`. Then call `whoami` first to
load your shared sticky as context.

## Docs
- **[plans/phase2-hosted-oauth.md](./plans/phase2-hosted-oauth.md)** — the current, authoritative design + build plan.
- **[SPEC.md](./SPEC.md)** / **[CLAUDE.md](./CLAUDE.md)** / **[NEXT.md](./NEXT.md)** — earlier
  Phase-0/1 docs. **Superseded in places by the pivot** (they describe a 9-tool focus+item model
  that no longer ships); the plan above is the source of truth.

## License
AGPL-3.0 (network-use clause closes the SaaS loophole; relicense to permissive later is possible, the reverse isn't).
