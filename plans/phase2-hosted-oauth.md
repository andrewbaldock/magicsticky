# magicsticky Phase 2 — hosted web app + Claude connector (v3, post-pivot)

> v3, 2026-06-17. Supersedes v1/v2. Reflects Andrew's product pivot + Cowork's pivot review
> (CONVO-CW). Direction APPROVED by Cowork ("more manifesto-true than v0"). Plan lives in-repo
> so Cowork can read it. Phase-1 stdio code (item tools) is retired by this phase.

## The product (pivoted model)
A human **sticky-notes web app** where **one note doubles as the shared Claude prompt**.
- A **sticky = one free-text blob, ≤10,000 chars** (a shared constant the server ENFORCES and the
  UI shows via a live character counter). No focus/items/sections/status — that structure is gone.
- **Public landing `magicsticky.andrewbaldock.com` = a live sticky you type into, NO auth.** Text
  lives in **localStorage** (client draft) — nothing hits the DB until you save. CTA: "save this —
  sign in with Google."
- **Google sign-in → a stack of 10 stickies** (default 10, soft cap, expandable later). Single-user
  (Andrew) for now; may demo.
- **Sticky 1 on signup** = the carried-over pre-auth draft + an auto-appended onboarding blurb
  (what the Claude plugin is + how to install it). It is the DEFAULT shared sticky at t=0.
- **Exactly one of the 10 is the "shared prompt"** — the only one Claude reads. The other 9 are
  write-at-will human notes. UI shows a **"SHARED PROMPT" lozenge** on the flagged one. Both the UI
  (click the lozenge) and the Claude plugin can flip which is shared.

## Why this is still a sticky note (manifesto check — Cowork blessed)
The structured list was the least sticky-note-ish part; collapsing to a free-text blob is a RETURN
to the manifesto. Capture-is-one-step (type in the box), read-is-free (the shared blob), flat (a
stack, no nesting), you-own-it, whoami-first — all hold. Surface SHRINKS (9→4 tools; no Supabase/
RLS/OAuth-AS; no auto-purge). "Saying no is the work."

## MCP tool surface — 4 tools (was 9)
The connector authenticates with a **static per-account bearer token** (see Auth). Tools:
1. `whoami()` → the shared sticky's text + a `version` + char count. CALL FIRST (server
   `instructions` already says so). This is the ambient-memory read.
2. `write({ text, version })` → REPLACE the shared sticky's text. **Optimistic concurrency:** must
   pass the `version` from the last read; server REJECTS on mismatch (→ re-read, merge, retry).
   Enforces the 10k cap and FAILS LOUDLY (no silent truncation). Stashes prior text (1-deep undo).
3. `list_stickies()` → the stack: **METADATA ONLY** (id, position, char count, which is shared).
   **NEVER the text of the other 9** — this is the privacy boundary that makes "only the shared one
   is readable by Claude" true. The connector returns sticky text ONLY via `whoami`/read.
4. `set_shared({ id })` → set which sticky is the shared one (moves the flag; LWW on one value).
   (Renamed from `use_sticky`: meaning changed — it now flips the GLOBAL flag that changes what
   every Claude reads, not a per-session pointer. On a 4-tool surface, names are the API.)

Retired with the item model: `add`, `complete`, `update`, `get_list`, `set_focus`, `create_sticky`.
(Creating/deleting stickies within the fixed stack is a web-UI action, not a tool — keeps surface
minimal. Revisit only if the plugin genuinely needs it.)

## Auth (two distinct paths — do NOT conflate)
- **Human (web app / save CTA): Google sign-in.** Establishes the account; single-user for now.
- **Machine (Claude plugin): a static per-account BEARER TOKEN** Andrew pastes when registering the
  connector. THIS is what kills the OAuth-AS complexity (not Google). Softens SPEC §9 to "any
  Claude, one token" for MVP; full OAuth 2.1 is a later/if-multi-user concern. Token is revocable
  (rotate the secret).

## Data model (SQLite on a Fly volume — `bun:sqlite`)
One table replaces SPEC §7's three:
```sql
CREATE TABLE sticky (
  id          TEXT PRIMARY KEY,          -- uuid
  user_id     TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',  -- the blob (AEAD-encrypted at rest; see Privacy)
  prev_text   TEXT,                      -- 1-deep undo of the last overwrite
  is_shared   INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL,          -- order in the stack of 10
  version     INTEGER NOT NULL DEFAULT 0,-- optimistic-concurrency token
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
-- exactly one is_shared=1 per user: enforce in app + a partial unique index
CREATE UNIQUE INDEX one_shared_per_user ON sticky(user_id) WHERE is_shared = 1;
```
Plus an `account` row (user_id, google sub, plugin token hash, timestamps). Single-user now;
`user_id` carried from day one so multi-user is a config flip. RLS is moot (SQLite, single-user) —
scope with `WHERE user_id = ?` in the repo.

## Hosting / topology (decided in Cowork chat)
**ONE Fly app (Bun/Hono) serves PWA + `/api` + `/mcp` at one origin.** Skip Vercel. **NEVER proxy
`/mcp` through a Vercel edge rewrite** (long-lived Streamable-HTTP/SSE session would hit edge
timeouts). SQLite on a small Fly **volume**; `min_machines_running=1` (avoids scale-to-zero 502; SQLite on a
volume pins us to one machine anyway — MCP is stateless so sessions aren't the constraint, the
volume is). DNS via A Small Orange
→ `fly certs add`. `bun run deploy` = verify + smoke (boot, assert `/healthz`), not bare deploy.
ALWAYS ask Andrew before deploying.

## Privacy / encryption (SPEC §11 — holds)
TLS + Fly at-rest baseline; **AEAD app-layer encryption of `sticky.text`** (and `prev_text`) with a
server-held Fly-secret key, per-row key-id for rotation. NOT E2EE (server must decrypt to serve the
shared prompt to Claude). `export` = decrypted plaintext JSON behind auth (HTTP/UI, not a tool).
`delete-everything` = POST + confirmation token, never GET. Auto-purge is MOOT — the 10k cap IS the
size bound.

## Routes
- `/mcp` — GET + POST + DELETE (Streamable HTTP: SSE stream / client msgs / session teardown).
- `GET /healthz` — Fly health.
- Google OAuth callback routes (human sign-in).
- `GET /export` (decrypted JSON), `POST /delete-everything` (confirm-token) — behind auth.
- `GET /` — the public landing sticky (localStorage draft) + save CTA.
- `GET /app` (or post-auth) — the stack-of-10 UI with the shared-prompt lozenge + char counters.

## Build order (each step verified before the next)
1. **SQLite store module** (`bun:sqlite`): the `sticky` table + account row; repo with the same
   shape the tools call. **Version is a STORE-LEVEL compare-and-swap** — EVERY write path (the MCP
   `write` tool AND the web-UI `/api` save) goes through the same `writeShared(id, text, version)`
   that bumps + checks `version`, so the clobber guard can't be half-implemented. 1-deep undo
   (`prev_text`), 10k enforce (loud reject), single-shared invariant (partial unique index).
   Unit-test BOTH stale-write directions (tool-write-then-stale-UI-save AND UI-save-then-stale-
   tool-write must both reject), the cap reject, and a `list` test asserting NO `text` field.
2. **[DONE]** Hono app + `WebStandardStreamableHTTPServerTransport`, **STATELESS** (per-request
   transport+server; no Mcp-Session-Id, so horizontal-scale risk evaporates — see Risks). 4 tools
   wired to the store; bearer-token auth middleware on `/mcp`. HTTP smoke (SDK client over the wire)
   proves version-mismatch + over-cap rejections, the 401 gate, list-leaks-no-text. 8 tests green.
   Files: src/mcp.ts, src/app.ts, src/server-http.ts, test/http.test.ts.
3. **[DONE]** Google sign-in (human path) + account creation. `account` table (user_id, google_sub
   unique, email, onboarded). `findOrCreateAccount(sub, {email,draft})`: first sign-in creates the
   account + seeds sticky 1 = draft + onboarding blurb (composeSeed cap-guards: blurb survives
   whole, draft yields), marked shared (default at t=0); returning user gets account back, NO
   re-seed (blurb never re-injects — guarded by `onboarded`). `POST /auth/google` route with a
   `verifyGoogleToken` SEAM (injectable; real impl in server-http.ts verifies the Google ID-token
   JWT vs Google JWKS via `jose`, checks iss+aud, only wired when GOOGLE_CLIENT_ID set else 501).
   8 tests (seed, no-re-seed, cap-guard, route 200/401/400/501). NOTE: returns user_id for now;
   real session cookie/web-token lands with the PWA (step 5). Connector still uses the bearer token.
   Two step-2 hardening notes also folded in: constant-time token compare (sha256+timingSafeEqual)
   and the stateless cleanup confirmed (per-request server GC'd; no explicit close for JSON tools).
4. **AEAD-at-rest** on text/prev_text (key-id + rotation); round-trip test.
5. **Web UI**: stack of 10, free-text editing, **live char counter**, interactive **shared-prompt
   lozenge** (click to flip). Public landing sticky + save CTA (localStorage → POST on auth).
   **Autolink bare URLs at render time** (display affordance only; storage stays plain text, no
   markdown editor, no `[text](url)`). Security: HTML-escape the sticky text BEFORE linkifying
   (untrusted input → XSS), emit `rel="noopener noreferrer"`. The MCP path is untouched — Claude
   reads/writes raw text; linkify is human-view only.
   **`prev_text` undo:** stash-only for MVP (recoverable via `/export` or DB). If cheap, expose a
   one-click "undo last overwrite" on the shared sticky — the natural payoff after a Claude `write`
   surprises the user. Otherwise note stash-only and defer the button.
6. **`/export` (decrypted) + `POST /delete-everything` (confirm-token).**
7. **DATA MIGRATION (before stdio retires):** import Andrew's live `~/.magicsticky/store.json`
   (the dogfood jobhunt content) — flatten its items into one text blob — into its OWN slot (e.g.
   sticky 2), NOT sticky 1 (step 3 already seeded that with the pre-auth draft + onboarding). Do
   NOT auto-flip `is_shared` to the imported slot. VERIFIED. Don't launch empty.
8. **Fly deploy**: volume, `/healthz` + smoke, custom domain via A Small Orange, certs,
   `min_machines_running=1`.
9. **Spec rewrite** (do as part of the build, lands with code):
   - §1 pitch: drop "running-list"; it's "a small stack of sticky notes, one is the shared context."
   - §2/§3: drop focus+items; "a sticky = free-text ≤10k; you hold ~10; one is the shared prompt."
   - §6: rewrite to the 4 tools (`whoami` / `write`+version / `list_stickies` / `set_shared`).
   - §7: collapse to the one `sticky` table above + account row.
   - §4/§5/§9/§11 HOLD. Optional new §4 refusal: no rich-text rendering engine (plain text;
     markdown-by-convention, rendered by whoever reads it).
   - §8: kill the stale per-sticky `/<slug>/mcp` diagram (one account `/mcp`).
   - README: connector registration with the bearer token.

## Risks
- **`write` concurrency** is THE risk (two writers on the shared sticky) — mitigated by step-1
  optimistic version + undo. Test it explicitly.
- **Data migration** (step 7) touches his real list — verify before stdio retires.
- **Onboarding blurb**: must be freely deletable, must not re-inject on re-auth, must not push
  sticky 1 over 10k (prepend on a fresh line; guard the cap if the draft is already large).
- **Sessions + scale:** RESOLVED by going stateless (step 2) — no in-memory sessions, Fly can
  scale out freely. (Original concern, kept for context:) in-memory sessions would have assumed the
  single pinned machine. Doc
  the assumption; horizontal scale would need a shared session store / stateless mode.

## Explicitly NOT in Phase 2 (anti-scope holds)
Items/sections/status (gone for good), nesting, sharing/read-links, search, rich-text rendering
engine (autolinking bare URLs is the ONLY render affordance — no markdown/formatting), full
multi-tenant OAuth/IdP, E2EE, any 5th+ tool without a manifesto check.
