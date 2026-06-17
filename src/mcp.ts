// Magic Sticky — Phase 2 MCP server. The 4-tool surface for the pivoted model, backed by the
// SQLite Store. A sticky is one free-text blob; exactly one is the "shared prompt" Claude reads.
//
// Tools (SPEC v3 §6):
//   whoami()           — read the shared sticky's text + version + char count. CALL FIRST.
//   write(text,version)— REPLACE the shared sticky's text. Compare-and-swap on version; 10k cap.
//   list_stickies()    — the stack, METADATA ONLY (never the other notes' text).
//   set_shared(id)     — flip which sticky is the shared one.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Store, MAX_CHARS, VersionConflictError, TooLongError, NotFoundError } from "./db.ts";

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

// Build a fresh McpServer scoped to one user. Stateless transport creates one per request, so this
// runs per call — keep it cheap. `userId` is resolved from the connector's bearer token.
export function buildMcpServer(store: Store, userId: string): McpServer {
  const server = new McpServer(
    { name: "magicsticky", version: "0.2.0" },
    {
      instructions:
        "Magic Sticky is the user's living context: a small stack of free-text sticky notes, one " +
        "of which is the ACTIVE shared prompt that every one of the user's Claudes reads. ALWAYS " +
        "call `whoami` first, before anything else — it returns the shared sticky's text, so you " +
        "instantly inherit who the user is and what they're doing right now without being told. To " +
        "update it, call `write` with the new full text AND the `version` you got from `whoami` " +
        "(this prevents clobbering an edit the user made in their browser; on a version conflict, " +
        "call `whoami` again, merge, and retry). `list_stickies` shows the stack as metadata only — " +
        "you can never read the other notes' text, only the shared one. `set_shared` changes which " +
        "note is the shared prompt. Keep it a sticky note: plain text, no folders or structure.",
    },
  );

  server.registerTool(
    "whoami",
    {
      description:
        "Read the user's ACTIVE shared sticky: its text, a version token, and char count. Call this " +
        "FIRST in a session to load the user's current context. Pass the returned `version` to `write`.",
      inputSchema: {},
    },
    async () => {
      const shared = store.getShared(userId);
      if (!shared) {
        return ok({ text: "", version: null, char_count: 0, note: "No shared sticky set yet." });
      }
      return ok({
        text: shared.text,
        version: shared.version,
        char_count: shared.char_count,
        updated_at: shared.updated_at,
      });
    },
  );

  server.registerTool(
    "write",
    {
      description:
        `Replace the shared sticky's text (full overwrite, max ${MAX_CHARS} chars). You MUST pass the ` +
        "`version` from your most recent `whoami`. If someone edited it since, the write is rejected " +
        "with a version conflict — call `whoami` again, merge your change in, and retry.",
      inputSchema: {
        text: z.string().describe("The new full text of the shared sticky"),
        version: z.number().int().describe("The version from your last whoami; guards against clobbering"),
      },
    },
    async ({ text, version }) => {
      const shared = store.getShared(userId);
      if (!shared) return fail("No shared sticky set yet — set one with set_shared first.");
      try {
        const updated = store.writeShared(userId, shared.id, text, version);
        return ok({ text: updated.text, version: updated.version, char_count: updated.char_count });
      } catch (e) {
        if (e instanceof VersionConflictError)
          return fail(`Version conflict: you had ${e.expected}, current is ${e.actual}. Call whoami again, merge, and retry.`);
        if (e instanceof TooLongError) return fail(e.message);
        if (e instanceof NotFoundError) return fail(e.message);
        throw e;
      }
    },
  );

  server.registerTool(
    "list_stickies",
    {
      description:
        "List the user's stack of stickies as METADATA ONLY (id, position, char count, and which is " +
        "shared). You cannot read the text of any sticky here — only the shared one, via whoami.",
      inputSchema: {},
    },
    async () => {
      return ok({ stickies: store.list(userId) });
    },
  );

  server.registerTool(
    "set_shared",
    {
      description:
        "Set which sticky is the ACTIVE shared prompt (by id, from list_stickies). Every Claude reads " +
        "whichever is shared. This changes what whoami returns.",
      inputSchema: { id: z.string().min(1).describe("Sticky id to make the shared prompt") },
    },
    async ({ id }) => {
      try {
        const s = store.setShared(userId, id);
        return ok({ id: s.id, is_shared: s.is_shared, char_count: s.char_count });
      } catch (e) {
        if (e instanceof NotFoundError) return fail(e.message);
        throw e;
      }
    },
  );

  return server;
}
