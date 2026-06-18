# Magic Sticky — Architecture

> Companion to the diagram: [`architecture.drawio.svg`](./architecture.drawio.svg) (editable in
> draw.io). This doc is the written reference; the plan with build history is
> [`../plans/phase2-hosted-oauth.md`](../plans/phase2-hosted-oauth.md).

## One sentence
A hosted sticky-notes web app where **one note is the shared prompt any Claude reads** — a single
Bun/Hono process on Fly serves the React PWA, a human `/api`, and an MCP connector at `/mcp`, all
backed by one SQLite file on a volume.

## The shape (one origin, one process)
```
                 magicsticky.andrewbaldock.com  (Fly edge, TLS)
                              │
                   ┌──────────┴───────────┐  one Bun + Hono process
                   │   /            → React PWA (web/dist, SPA)        │
                   │   /assets/*    → hashed JS/CSS                    │
                   │   /manifest…,/sw.js,/icon* → PWA shell            │
                   │   /auth/google → Google sign-in (GIS token)       │
                   │   /api/*       → human API (session cookie)        │
                   │   /mcp         → MCP connector (bearer token)      │
                   └──────────┬───────────┘
                              │
                       SQLite (bun:sqlite) on a Fly volume at /data
                       text encrypted at rest (AES-256-GCM, AAD=user_id)
```

## Two clients, two auth paths (never conflated)
- **Humans** → the PWA. Sign in with Google (GIS token flow), get an **HMAC-signed httpOnly session
  cookie**; `/api/*` is gated on it. An allowlist (`MAGICSTICKY_ALLOWED_*`) controls *who* may create
  an account (deny-all by default).
- **Claude (any client)** → the **MCP connector** at `/mcp`, authenticated by a per-account
  **bearer token** (`msk_…`, sha256-hashed at rest). A Claude obtains that token one of two ways,
  depending on what the client supports — both end at the *same* `/mcp` bearer check, so the store
  sees one auth path:
  - **Static header** (Claude Code): paste the `msk_…` token into `.mcp.json`'s `Authorization`
    header. The bootstrap env token also works (single user).
  - **OAuth** (desktop / phone / Cowork — no header field in their dialog): Magic Sticky is its own
    minimal **OAuth 2.1 Authorization Server**. A 401 from `/mcp` carries a `WWW-Authenticate`
    `resource_metadata` pointer (RFC 9728); the client discovers `/.well-known/oauth-*`, registers
    (RFC 7591 DCR), runs the authorization-code flow with **PKCE S256** + an RFC 8707 `resource`,
    and the token endpoint returns a per-client connector token as the `access_token`. The human leg
    reuses the Google session; **every Claude that connects gets its own token, all resolving to the
    one account** — that's the "all Claudes share one prompt" guarantee. (`src/oauth.ts` + the
    `/oauth/*` routes in `src/app.ts`; tokens in the `connector_token` table.)

  The human and machine paths share nothing but the store.

## Data model (one table)
`sticky`: `id, user_id, text, prev_text, char_count, key_id, is_shared, position, version,
timestamps` + an `account` row. A sticky is **one free-text blob ≤10k** (markdown-by-convention;
rendered in the read view, stored as plain text). Exactly one sticky per user is `is_shared`
(enforced by a partial unique index) — that's the prompt Claude reads.

## The load-bearing invariants
- **One write path, version CAS.** `writeShared(id, text, expectedVersion)` is the *only* mutate
  path the MCP `write` tool and the human `PUT /api/stickies/:id` both call — a stale write is
  rejected (409), so the shared sticky's two writers (human + Claude) can't clobber each other.
- **Privacy boundary as a type.** `list()` (the connector path) returns metadata only — never the
  other notes' text. The human-only `listWithTitles()` is the sole place a title is derived.
- **Encryption inside the Store.** Callers always deal in plaintext; `text`/`prev_text` are
  AES-256-GCM at rest with `user_id` bound as AAD (a leaked-DB row-swap won't decrypt cross-user).
  `char_count` is its own column so the cap/counter stay correct over ciphertext.

## The 4 MCP tools
`whoami` (read the shared sticky + version), `write` (replace it, version-guarded), `list_stickies`
(metadata only), `set_shared` (flip which note is shared). No tool reads a non-shared note's text.

## PWA + offline
A hand-written **service worker** (`web/public/sw.js`) caches the app shell (runtime cache, never
`/api`/`/auth`/`/mcp`) so it loads offline. Offline **catch-up** mode captures a note (TEXT → lowest
non-shared sticky, auto-created if none; CLAUDE → the shared sticky) in localStorage and, on
reconnect, **appends** it below a `------ pwa catch-up <stamp> -----` divider. Append-only =
conflict-free: it never overwrites, so an edit made elsewhere while offline is preserved.

## Deploy
One Fly app (`magicsticky`, sjc), multi-stage Docker (build `web/dist` → Bun runtime),
`min_machines_running=1`, SQLite on a volume. Secrets via `fly secrets`; prod refuses to boot
without `MAGICSTICKY_KEYS`. Custom domain via a DNS-only CNAME → Fly, `fly certs add`. **Never** put
`/mcp` behind an edge proxy — the Streamable-HTTP/SSE session is long-lived and would time out.
