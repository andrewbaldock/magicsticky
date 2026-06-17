# NEXT — handoff to Claude Code (Phase 1)

> Read `SPEC.md` (design) and `CLAUDE.md` (working agreements) first. This is the concrete Phase-1
> build. **Cowork is not implementing this — you (Claude Code) are.** Andrew reviews & commits.

## Goal of Phase 1
A **local MCP server (stdio)** that proves the loop end-to-end and becomes Andrew's real TODO
backend. No hosting, no OAuth, no web UI yet — those are Phases 2–3.

## Stack
Bun + TypeScript + `@modelcontextprotocol/sdk` + `zod`. Storage = a single JSON file (lean default;
SQLite only if you find a concrete reason). Suggested store path: `~/.magicsticky/store.json`.

## Store shape (keep it dumb)
```jsonc
{
  "active": "jobhunt",                       // the shared "glue" pointer (persists)
  "stickies": {
    "jobhunt": {
      "title": "Job hunt",
      "focus": "Interviewing; General Medicine Fri 6/19.",
      "items": [
        { "id": "…", "text": "…", "section": "inbox", "status": "open",
          "rank": null, "created_at": "…", "completed_at": null }
      ]
    }
  }
}
```
Atomic writes (write temp + rename). `active` is the persisted account-wide selection.

## Build steps
1. `bun init`; add deps; set a `start` script and `bin`.
2. Storage module: load/save the JSON doc above; helpers for stickies, items, and the `active` pointer.
3. Implement **exactly** the tools in SPEC §6 — no more, no fewer:
   - Browse/pick/create: `list_stickies`, `use_sticky`, `create_sticky`
   - Per-sticky (act on `active`, accept optional `sticky` slug): `whoami`, `get_list`, `add`, `complete`, `set_focus`, `update`
   - `use_sticky` mutates `active` (the glue). `whoami` returns the active sticky's focus + open count.
4. Wire `McpServer` + `StdioServerTransport`; zod schemas for every tool input.
5. Update `README` with: how to run, and how to register the server in **Claude Code** (`.mcp.json` /
   `claude mcp add`) and in **Cowork**.
6. Write a smoke test exercising `create_sticky → use_sticky → add → get_list → complete → whoami`.
   **Run it and verify before claiming done** (CLAUDE.md rule).

## Guardrails (the prime directive)
- Tool surface stays at those ~9. Anything else → add it to SPEC §4 (anti-scope), don't build it.
- `add` requires only `text` (+ optional `section`). Capture is always one step.
- Stickies are a flat set — no nesting/folders/linking.
- Don't `git commit`; leave the tree clean and tell Andrew exactly what to test.

## Encryption / privacy (Phase 1 scope)
Local file only → rely on disk/FileVault; **no app-layer crypto yet.** True end-to-end encryption is
intentionally out of scope (it breaks the "any Claude can read the active note" feature — see SPEC §11).
App-layer column encryption is a Phase 2 (hosted) concern.

## Not now (later phases)
- **Phase 2:** hosted Bun/Hono + Supabase (Postgres + RLS) + OAuth + the one account URL
  `magicsticky.andrewbaldock.com/mcp`; add app-layer column encryption (SPEC §11).
  - **Carry-overs to honor here (flagged by Cowork, 2026-06-17):**
    - `export` + `delete-everything` must NOT be migration-gated (SPEC §11 "from day one").
      In Phase 1 the JSON file *is* the export and `rm` *is* delete; once data moves to Postgres,
      ship an explicit wipe path so leaving is never harder than arriving.
    - **Slug scheme is provisional.** Phase-1 JSON keys are slugs, but SPEC open-Q #1 (per-user
      vs global uniqueness) is unresolved — decide before baking slugs into public Phase-2 URLs.
- **Phase 3:** one-screen PWA per sticky for one-tap human capture.
