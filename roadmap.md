# Roadmap — Magic Sticky

Future ideas and deferred changes. Nothing here is committed work; it's the "someday/maybe" list.
For the concrete next build, see `NEXT.md`; for the design, `SPEC.md`.

## Ideas / deferred

- [ ] **Raise the per-sticky char limit.** Today a sticky is capped at `MAX_CHARS = 10_000`
  (see `src/db.ts:18`; the store enforces it and the MCP tool descriptions advertise it). We want
  bigger stickies at some point — raise (or remove) the cap. Not urgent; do it when a real note
  bumps into the limit.
