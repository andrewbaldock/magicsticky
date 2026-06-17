# Magic Sticky — Design Spec (v0)

> A frictionless personal-context + running-list store that **any Claude** (and you, on any device) can read and write. Each **sticky** holds two things — *a focus* ("who/what this is, right now") and *a flat list* — and has its own **URL** for viewing/sharing. You connect a Claude once to your **single account URL** (`magicsticky.andrewbaldock.com`), then browse, pick the active note, or start a new one. Whatever you pick becomes the **shared active note across all your Claudes until you change it** — one in-the-moment context, glued across every AI you use. Nothing else. The whole product is the discipline of nothing else.

---

## 1. One-sentence pitch
Cloud sticky notes for your life — each at its own URL — that any Claude you talk to can read, update, or spin up, and that you can reach in one tap from any device.

## 2. Why it exists
Every time you reach for a Claude, it starts cold — it doesn't know you're mid–job-hunt, or what's on your plate. And every "jot this down" tool you've tried (Evernote, Notion, …) eventually grew into a second job. Magic Sticky is the opposite bet: **stay tiny forever**, and be the one thing that gives every AI you use an instant, current picture of whatever you point it at.

Two faces of the same idea:
- **Ambient memory for your AIs** — a `whoami` any Claude can pull at the start of a session: "this sticky is *job hunt*; here's the focus, here's the list."
- **Frictionless capture for you** — one tap to add a thought; it's everywhere instantly.

## 3. Principles (the manifesto)
1. **It stays a sticky note.** Every proposed feature must pass one test: *is this still a sticky note?* If not, it's a no.
2. **Capture is one step.** Adding an item never requires choosing a tag, a date, or a priority. Triage is optional and later.
3. **The data is dumb.** Per sticky: a focus string + a flat list. Structure is the enemy.
4. **Read is free, everywhere.** Any Claude, any device, one OAuth / one tap.
5. **Stickies are flat.** You can have many, but they're an unordered set of independent notes — never a tree.
6. **You own it.** Your infra, your data, exportable and deletable. It's a memory *of you*.
7. **Saying no is the work.** The roadmap is mostly a list of things we refuse to build.

## 4. What it is NOT (anti-scope — keep this list growing)
No folders or nesting *between* stickies (they stay a flat set). No rich text. No sharing/collaboration (maybe per-sticky read links later — see open questions). No reminder/notification engine. No recurring tasks. No tag taxonomy. No attachments. No calendar. No integrations marketplace. No AI features inside the app (the AI is the *client*, not a feature). When one of these starts to feel necessary, write it here instead of building it.

## 5. Mental model
- A **sticky** is the unit. It has a **URL** (you pick the slug — claiming a URL *is* creating a sticky: `magicsticky.app/jobhunt`, `…/house`, `…/aether`), a **focus** (one short string, overwritten as things change), and a **list** (flat set of items).
- An **item** is text + a status (`open`/`done`) + a light bucket (`priority`/`inbox`/`later`). Capture lands in `inbox`; triage moves it. That's all an item is.
- You can have **many stickies**, one per context. They don't nest, link, or roll up. Switching context = switching sticky (= switching URL).

## 6. Tool surface (intentionally tiny)
The connector authenticates to your **account** via one URL (OAuth). It does NOT bind to a single sticky. Your account has one **active sticky** that persists server-side: set it once (via any Claude or the web view) and it's the **shared active note across all your Claudes until you change it**. Per-sticky tools act on the active sticky; pass `sticky` to override for a single call without moving the shared pointer.

**Browse / pick / create** (account-level):
```
list_stickies()                  -> { stickies: [{ slug, title, url, open_count }] }   // browse
use_sticky({ slug })             -> { sticky, focus }    // set the account's active note (persists across ALL your Claudes)
create_sticky({ slug?, title? }) -> { sticky, url }      // start a new one; returns its URL
```

**Per-sticky** (operate on the active sticky; pass `sticky` to override for one call):
```
whoami({ sticky? })              -> { sticky, focus, open_count, updated_at }
   Cheap, read-only. Call at the START of a session to load the active note as context.
get_list({ status?, section?, sticky? })    -> { items: Item[] }
add({ text, section? = "inbox", sticky? })   -> { item }   // text is the only required field, ever
complete({ id, sticky? })                    -> { item }
set_focus({ text, sticky? })                 -> { focus, updated_at }
update({ id, text?, section?, status?, rank?, sticky? })  -> { item }   // minimal triage only
```

That's the whole surface — ~9 tools. Expanding it requires a manifesto check. Ordering within a section: `rank` (nullable, manual) then `created_at`. No drag engine, no auto-prioritization.

## 7. Data model
Postgres (Supabase). Three tables. Single-user to start, but `user_id` + RLS from day one so multi-user is a config flip.

```sql
create table sticky (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id),
  slug       text not null,              -- appears in the URL
  title      text not null default '',
  focus      text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, slug)                 -- slug unique per owner (see open Q on global uniqueness)
);

-- the shared "active note" pointer — this is the glue across all your Claudes
create table account_state (
  user_id          uuid primary key references auth.users(id),
  active_sticky_id uuid references sticky(id) on delete set null,
  updated_at       timestamptz not null default now()
);

create type item_section as enum ('priority', 'inbox', 'later');
create type item_status  as enum ('open', 'done');

create table item (
  id           uuid primary key default gen_random_uuid(),
  sticky_id    uuid not null references sticky(id) on delete cascade,
  text         text not null,
  section      item_section not null default 'inbox',
  status       item_status  not null default 'open',
  rank         int,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index on item (sticky_id, status, section, rank);
```

RLS keyed on the owning `user_id` (via `sticky`). That's the whole schema; resist adding columns.

## 8. Architecture
Reuses your `aether` toolbelt so there's nothing new to operate.

- **Server:** Bun + Hono. One small HTTP service.
- **MCP:** `@modelcontextprotocol/sdk` (TypeScript) over **Streamable HTTP**, so it registers as a **remote/custom connector** in claude.ai, mobile, Cowork, and Claude Code.
- **URLs:**
  - Connector endpoint (one per account): `https://magicsticky.andrewbaldock.com/mcp` — register this once in any Claude; OAuth scopes it to you. It reaches *all* your stickies.
  - Per-sticky human view (Phase 3 PWA): `https://magicsticky.andrewbaldock.com/<slug>` — for viewing / bookmarking / one-tap capture; `create_sticky` returns this.
  - A Claude switches between stickies with `use_sticky`; the connector URL never changes.
- **Storage:** Supabase (Postgres + RLS).
- **Auth:** OAuth 2.1 (MCP remote-server flow). One consent per Claude client; tokens scoped to your account. OAuth proves the stickies are *yours*; `use_sticky` chooses which one is *active*.
- **Hosting:** Fly.io (`fly deploy`), same as the Aether backend.
- **Human surface (Phase 3):** a single-screen PWA per sticky — focus on top, list below, one always-focused "add" box — installable to your phone. This is what a bookmark/short-URL points at.

```
[ Any Claude ]──MCP/OAuth──> /<slug>/mcp ┐
                                         ├─> [ Bun+Hono ]─> [ Supabase / Postgres ]
[ Phone PWA / web ]──HTTP──> /<slug>     ┘
```

## 9. The honest hard part: "every Claude just knows me"
MCP tools are **pulled on demand** — a server can't *push* context into a fresh session. But because the **active sticky is persisted account-wide**, any Claude only has to call `whoami` once and it inherits the same shared context — you never re-tell each one which note you're on. The remaining convention is just: *call `whoami` first.*
- **Claude Code:** a one-line `CLAUDE.md` instruction — "call `whoami` at the start" — optionally a session-start hook.
- **Cowork / web / mobile:** one saved instruction / habit to call `whoami` first.

This is the single biggest UX risk: the magic still depends on the *client* making that first `whoami` call. Naming and docs that make it the obvious opening move are part of the product.

## 10. Auth & multi-user
MVP is single-user (you). Every row carries the owning `user_id` with RLS from the start, so multi-user later = enabling sign-up, not migrating data. No team/sharing features regardless (see anti-scope).

## 11. Privacy, ownership & encryption
It's a *memory of you* — treat it as sensitive by default. Your Supabase project, your Fly app. Baseline (mostly free): **TLS in transit** everywhere (Fly + custom domain) and **at-rest disk encryption** (Supabase default). Scope/revoke OAuth tokens; ship `export` (JSON dump) and `delete-everything` from day one. Auto-purge completed items after N days (lean yes — keeps it a sticky note).

**On end-to-end encryption — the honest constraint:** true zero-knowledge E2EE (server *can't* read your notes) is **incompatible with the core feature**. The whole point is that any Claude pulls the active sticky as plaintext context via `whoami`/`get_list`, so the server must be able to produce readable content. You can't simultaneously have "any Claude reads it" and "the server can't." Therefore:
- **Do:** TLS + at-rest disk encryption + (optional, recommended) **app-layer column encryption** of `focus` and item `text` with a server-held key, so a leaked DB dump/backup isn't plaintext. The running server still decrypts to serve MCP clients.
- **Don't:** chase client-held-key E2EE — it would break the product. Revisit only if the threat model changes (multi-tenant SaaS with untrusted operators).
- **MVP:** Phase 1 is a local JSON file on your own machine — lean on disk/FileVault, no app crypto needed yet. App-layer column encryption is a Phase 2 (hosted) concern.

## 12. Build phases
- **Phase 0 — this spec + schema.** (done when you bless it)
- **Phase 1 — local MCP server.** Bun + `@modelcontextprotocol/sdk` over stdio, file/SQLite-backed, multi-sticky, wired into Claude Code + Cowork. Proves the loop end-to-end with zero hosting and becomes your real TODO backend (dogfood: first sticky = `jobhunt`).
- **Phase 2 — hosted + OAuth.** Swap storage to Supabase, add Hono HTTP + per-sticky `/mcp` URLs + OAuth, deploy to Fly. Any Claude + your phone hit the same stickies.
- **Phase 3 — PWA capture surface.** One-screen installable web app per sticky; point bookmarks/short-URLs here.
- **Phase 4 — restraint.** Use it for two weeks. The only allowed work is deleting friction.

## 13. Open questions (decide as we go)
1. **Slug uniqueness:** per-user (nice short slugs, but `/<slug>` URLs must then be account-scoped) vs global (cleaner public URLs, uglier slugs). Affects the URL scheme — resolve before Phase 2.
2. **Private vs shareable URL:** default private (OAuth-gated; the URL only *selects* a sticky, doesn't grant access). Optional later: an unguessable per-sticky read link for light sharing. MVP = private only.
3. Local store for Phase 1: flat JSON (simple, diff-able) vs SQLite. Lean JSON.
4. Is `text` truly all an item has, or is a `note`/body worth it? Lean: text only.
5. Completed items — auto-purge after N days vs keep a short DONE log.
6. `focus`: one string, or a tiny "current + on-deck" stack? Lean: one string. Resist.

## 14. Stack summary
Bun · Hono · `@modelcontextprotocol/sdk` (TS) · Supabase (Postgres + RLS) · Fly.io · (Phase 3) minimal PWA. Match the repo's conventions once set.

---
_Drafted 2026-06-17 (Cowork). Phase-0 design doc. Point me at the new `magicsticky` repo and I'll drop this in as `SPEC.md` plus a `CLAUDE.md` of working notes, then start Phase 1._
