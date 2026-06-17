# magicsticky

Frictionless text notes — for humans AND shared AI prompts.

Cloud sticky notes for your life: each sticky has its own URL, and **any Claude** can read, update,
or create them — reachable in one tap on any device. One shared **active note** is the glue across
all your Claudes: set it once and every Claude inherits it (via `whoami`) until you change it.

The whole product is the discipline of staying a sticky note — see the manifesto in the spec.

## Docs
- **[SPEC.md](./SPEC.md)** — full design: principles, anti-scope, the ~9-tool surface, schema, architecture, privacy/encryption.
- **[CLAUDE.md](./CLAUDE.md)** — working agreements for AI assistants in this repo.
- **[NEXT.md](./NEXT.md)** — Phase 1 build handoff. **Claude Code starts here.**

## Phase 1 — local MCP server (stdio)

A local stdio MCP server in Bun + TypeScript. It's the real backend for Andrew's TODO
(dogfooded). No hosting, OAuth, or web UI yet — those are Phases 2–3.

### Run it

```sh
bun install
bun start          # serves MCP over stdio (no output until a client connects)
bun test           # end-to-end smoke test: drives all 9 tools over a real stdio server
```

Storage is a single JSON file at `~/.magicsticky/store.json` (atomic writes). Override the
path with the `MAGICSTICKY_STORE` env var (the test suite uses a temp dir).

### Register in Claude Code

```sh
claude mcp add magicsticky -- bun run /Users/andrewbaldock/Code/magicsticky/src/server.ts
```

Or add to a project's `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "magicsticky": {
      "command": "bun",
      "args": ["run", "/Users/andrewbaldock/Code/magicsticky/src/server.ts"]
    }
  }
}
```

> **Convention:** call `whoami` at the start of a session to inherit the active sticky as
> context (see SPEC §9). A one-line `CLAUDE.md` instruction makes it the obvious opening move.

### Register in Cowork

Add a custom stdio MCP server with command `bun` and args
`run /Users/andrewbaldock/Code/magicsticky/src/server.ts`. Same active-sticky pointer; the
two clients share `~/.magicsticky/store.json`.

### The 9 tools

Browse/pick/create: `list_stickies` · `use_sticky` · `create_sticky`.
Per-sticky (act on the active sticky; pass `sticky` to override for one call):
`whoami` · `get_list` · `add` · `complete` · `set_focus` · `update`.

`use_sticky` sets the account-wide **active sticky** that persists across all clients —
that shared pointer is the whole point. `add` requires only `text`; capture is one step.

## License
AGPL-3.0 (network-use clause closes the SaaS loophole; relicense to permissive later is possible, the reverse isn't).
