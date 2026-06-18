# Magic Sticky — SwiftBar control panel

A [SwiftBar](https://github.com/swiftbar/SwiftBar) menu-bar plugin to start/stop the Magic Sticky
dev servers, run tests, deploy, and open the live app — with a live up/down 🌼 glyph (green = both
servers up, red = something down). Mirrors the aether plugin (`~/Code/aether/tools/swiftbar`).

## What it controls
- **magicsticky-api** (`:3001`, `bun run start`) — health via `/healthz`
- **magicsticky-web** (`:5180`, `bun run dev:web`) — Vite, proxies `/api`+`/auth` → :3001
- Tests (bun unit, Playwright e2e), `vite build`, and a **Fly deploy** (with the
  `VITE_GOOGLE_CLIENT_ID` build-arg baked in)
- Links: open dev (`localhost:5180`), open live (`magicsticky.andrewbaldock.com`), docs, repo

## Install
1. Install SwiftBar (`brew install swiftbar`) and point it at a plugins folder
   (`~/Library/Application Support/SwiftBar/Plugins` is the default).
2. Symlink this script in (so edits in the repo are live):
   ```sh
   ln -sf "$HOME/Code/magicsticky/tools/swiftbar/magicsticky-servers.3s.sh" \
          "$HOME/Library/Application Support/SwiftBar/Plugins/magicsticky-servers.3s.sh"
   ```
   The `.3s.sh` suffix tells SwiftBar to refresh every 3 seconds.

## Notes
- GUI apps don't inherit your login PATH, so the script calls `bun`/`fly`/`lsof`/`curl` by absolute
  path (derived from `$HOME`).
- The API refuses to boot without `MAGICSTICKY_TOKEN`; it reads `.env` automatically (Bun), so a
  local `.env` must exist (see `.env.example`).
- Server logs go to `/tmp/magicsticky-api.log` and `/tmp/magicsticky-web.log` (openable from the menu).
