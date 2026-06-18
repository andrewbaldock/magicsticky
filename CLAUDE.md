# CLAUDE.md — working agreements for Magic Sticky

> ⚠️ **PARTIALLY SUPERSEDED (2026-06-18).** The product pivoted to a hosted web app: a sticky is one
> free-text blob (≤10k), the MCP surface is **4 tools** (`whoami`/`write`/`list_stickies`/`set_shared`),
> storage is SQLite-on-Fly (not the local JSON store), humans use Google sign-in + a per-account
> connector token. The working-agreement *principles* below (prime directive, privacy, verify-before-
> claiming-done, maintainer-commits) still hold; specifics about the 9-tool/stdio model are stale.
> Authoritative current design + build: **[plans/phase2-hosted-oauth.md](./plans/phase2-hosted-oauth.md)**.

Notes for any AI assistant (Claude Code, Cowork) working in this repo.

## What this is
Andrew's frictionless personal-context + running-list store. Two concepts only: a **focus**
string ("who I am right now") and a flat **list** of items. Any Claude reads/writes it over MCP;
Andrew reaches it one-tap on any device. Full design: see `SPEC.md`. This repo is also the
**backend for Andrew's own TODO** — we dogfood it.

## The prime directive: it stays a sticky note
Before adding ANY feature, field, table, or tool, ask: *is this still a sticky note?* If the answer
is no, don't build it — add it to the "What it is NOT" list in `SPEC.md` instead. Saying no is the
core engineering work here. Bloat is the only way this project fails.

## Tool surface (do not expand without an explicit ask)
Browse/pick/create: `list_stickies` · `use_sticky` · `create_sticky`.
Per-sticky: `whoami` · `get_list` · `add` · `complete` · `set_focus` (+ a minimal `update` for triage).
~9 tools. `add` requires only `text`; capture is always one step. The connector is ONE account URL
(`magicsticky.andrewbaldock.com/mcp`). `use_sticky` sets an account-wide **active sticky** that
persists across ALL of Andrew's Claudes until he changes it — that shared pointer is the whole point.
Stickies are a flat set (no nesting). Pass `sticky` to a per-sticky tool to act on another for one
call without moving the shared pointer.

## Stack (matches Andrew's `aether`)
- Runtime: **Bun** (no Node, no Docker).
- HTTP: **Hono**.
- MCP: `@modelcontextprotocol/sdk` (TypeScript). Phase 1 = stdio; Phase 2 = Streamable HTTP remote.
- Storage: Phase 1 flat JSON (or SQLite); Phase 2 **Supabase** (Postgres + RLS).
- Deploy: **Fly.io** (`fly deploy`). Fly does NOT auto-deploy — deploy after backend changes land.
- Frontend (Phase 3 only): minimal PWA. Keep it one screen.

## Build order
Phase 1 local MCP (prove the loop, become the live TODO backend) → Phase 2 hosted+OAuth (any
Claude + phone) → Phase 3 PWA capture surface → Phase 4 restraint (only delete friction).

## The "ambient memory" convention
MCP can't auto-inject context; clients pull tools on demand. But the active sticky is persisted
account-wide, so **calling `whoami` at the start of a session** inherits Andrew's shared current
context automatically — no need to re-select per Claude. Keep `whoami` cheap and obviously-named so
reaching for it first is natural.

## Privacy
This is a memory *of* Andrew — sensitive by default. Single-user for now but `user_id` + RLS from
day one. Ship `export` and `delete-everything` early. Lean toward auto-purging old completed items.

## Verify before claiming done
Run it. Exercise all five tools end-to-end (add → get_list → complete → set_focus → whoami) before
saying a phase works. Don't assume.

## The maintainer commits, not the assistant
Andrew reviews and commits. Don't `git commit` unless asked. Leave the tree clean; summarize what to test.
