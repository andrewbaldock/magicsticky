#!/usr/bin/env bun
// Magic Sticky — Phase 1 local MCP server (stdio).
// Exactly the ~9 tools in SPEC §6 — no more, no fewer. Expanding the surface
// requires a manifesto check (CLAUDE.md). Capture is always one step.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  load,
  save,
  now,
  slugify,
  newItem,
  openCount,
  type Sticky,
  type StoreDoc,
} from "./store.ts";

// Wrap a JSON payload as MCP text content. Keeping output as JSON text keeps
// every client (Claude Code, Cowork, web, mobile) happy without an outputSchema.
function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

// Resolve which sticky a per-sticky tool acts on: an explicit `sticky` slug for
// a one-off, otherwise the account-wide active pointer. Does NOT move `active`.
function resolveTarget(doc: StoreDoc, override?: string): { slug: string; sticky: Sticky } | null {
  const slug = override ?? doc.active;
  if (!slug) return null;
  const sticky = doc.stickies[slug];
  if (!sticky) return null;
  return { slug, sticky };
}

const NO_ACTIVE =
  "No active sticky. Pick one with use_sticky, or pass `sticky` for a one-off, or create_sticky.";

// `instructions` rides the MCP `initialize` response, so EVERY compliant client gets it —
// unlike CLAUDE.md, which a generic remote client never sees. This is where the
// "call whoami first" convention has to live to survive the client boundary (SPEC §9).
const server = new McpServer(
  { name: "magicsticky", version: "0.1.0" },
  {
    instructions:
      "Magic Sticky is the user's living context: a set of 'stickies', each a one-line focus plus a " +
      "flat list of items. One sticky is ACTIVE account-wide, shared across every one of the user's " +
      "Claudes. ALWAYS call `whoami` first, before anything else — it returns the active sticky's " +
      "focus and open-item count, which is how you instantly inherit who the user is and what they're " +
      "doing right now without being told. Capture is one step: `add` needs only `text`. Per-sticky " +
      "tools act on the active sticky by default; pass `sticky` to act on another for a single call " +
      "without moving the shared pointer. Keep it a sticky note — don't expect folders, threads, or " +
      "rich structure.",
  },
);

// ---------- Browse / pick / create (account-level) ----------

server.registerTool(
  "list_stickies",
  {
    description:
      "Browse all your stickies. Returns slug, title, open item count, and which one is active.",
    inputSchema: {},
  },
  async () => {
    const doc = await load();
    const stickies = Object.entries(doc.stickies).map(([slug, s]) => ({
      slug,
      title: s.title,
      open_count: openCount(s),
      active: slug === doc.active,
    }));
    return ok({ active: doc.active, stickies });
  },
);

server.registerTool(
  "use_sticky",
  {
    description:
      "Set the account's ACTIVE sticky — the shared note inherited across ALL your Claudes until you change it. This is the glue.",
    inputSchema: { slug: z.string().min(1).describe("Slug of the sticky to make active") },
  },
  async ({ slug }) => {
    const doc = await load();
    const sticky = doc.stickies[slug];
    if (!sticky) return fail(`No sticky with slug "${slug}". Use list_stickies to see them.`);
    doc.active = slug;
    await save(doc);
    return ok({ sticky: slug, focus: sticky.focus });
  },
);

server.registerTool(
  "create_sticky",
  {
    description:
      "Start a new sticky and make it active. A slug (claimed URL) is all it needs; title defaults from the slug.",
    inputSchema: {
      slug: z.string().min(1).optional().describe("URL slug; derived from title if omitted"),
      title: z.string().optional().describe("Human title; defaults to the slug"),
    },
  },
  async ({ slug, title }) => {
    const doc = await load();
    const baseSlug = slugify(slug ?? title ?? "");
    if (!baseSlug) return fail("Provide a slug or title to name the sticky.");
    if (doc.stickies[baseSlug]) return fail(`A sticky "${baseSlug}" already exists.`);
    const ts = now();
    doc.stickies[baseSlug] = {
      title: title ?? baseSlug,
      focus: "",
      items: [],
      created_at: ts,
      updated_at: ts,
    };
    doc.active = baseSlug; // creating one makes it the active note
    await save(doc);
    return ok({ sticky: baseSlug, url: `magicsticky.andrewbaldock.com/${baseSlug}` });
  },
);

// ---------- Per-sticky (act on active; optional `sticky` override) ----------

const stickyOverride = z
  .string()
  .min(1)
  .optional()
  .describe("Act on this sticky for one call without moving the active pointer");

server.registerTool(
  "whoami",
  {
    description:
      "Cheap, read-only. CALL THIS FIRST in a session to load the active sticky as context: its focus + open count.",
    inputSchema: { sticky: stickyOverride },
  },
  async ({ sticky }) => {
    const doc = await load();
    const t = resolveTarget(doc, sticky);
    if (!t) return fail(NO_ACTIVE);
    return ok({
      sticky: t.slug,
      title: t.sticky.title,
      focus: t.sticky.focus,
      open_count: openCount(t.sticky),
      updated_at: t.sticky.updated_at,
    });
  },
);

server.registerTool(
  "get_list",
  {
    description: "List items in the active sticky. Optionally filter by status or section.",
    inputSchema: {
      status: z.enum(["open", "done"]).optional(),
      section: z.enum(["priority", "inbox", "later"]).optional(),
      sticky: stickyOverride,
    },
  },
  async ({ status, section, sticky }) => {
    const doc = await load();
    const t = resolveTarget(doc, sticky);
    if (!t) return fail(NO_ACTIVE);
    let items = t.sticky.items;
    if (status) items = items.filter((i) => i.status === status);
    if (section) items = items.filter((i) => i.section === section);
    // Order within a section: rank (manual, nullable) then created_at (SPEC §6).
    const order: Record<string, number> = { priority: 0, inbox: 1, later: 2 };
    items = [...items].sort((a, b) => {
      if (a.section !== b.section) return order[a.section] - order[b.section];
      if (a.rank !== b.rank) {
        if (a.rank === null) return 1;
        if (b.rank === null) return -1;
        return a.rank - b.rank;
      }
      return a.created_at.localeCompare(b.created_at);
    });
    return ok({ sticky: t.slug, items });
  },
);

server.registerTool(
  "add",
  {
    description:
      "Capture an item. `text` is the ONLY required field, ever — capture is always one step. Lands in inbox by default.",
    inputSchema: {
      text: z.string().min(1).describe("The thing to remember — the only required field"),
      section: z.enum(["priority", "inbox", "later"]).optional().describe("Defaults to inbox"),
      sticky: stickyOverride,
    },
  },
  async ({ text, section, sticky }) => {
    const doc = await load();
    const t = resolveTarget(doc, sticky);
    if (!t) return fail(NO_ACTIVE);
    const item = newItem(text, section ?? "inbox");
    t.sticky.items.push(item);
    t.sticky.updated_at = now();
    await save(doc);
    return ok({ item });
  },
);

server.registerTool(
  "complete",
  {
    description: "Mark an item done (by id).",
    inputSchema: {
      id: z.string().min(1).describe("Item id"),
      sticky: stickyOverride,
    },
  },
  async ({ id, sticky }) => {
    const doc = await load();
    const t = resolveTarget(doc, sticky);
    if (!t) return fail(NO_ACTIVE);
    const item = t.sticky.items.find((i) => i.id === id);
    if (!item) return fail(`No item with id "${id}" in sticky "${t.slug}".`);
    item.status = "done";
    item.completed_at = now();
    t.sticky.updated_at = now();
    await save(doc);
    return ok({ item });
  },
);

server.registerTool(
  "set_focus",
  {
    description:
      'Overwrite the focus string ("who/what this is, right now"). One short line; it replaces the old one.',
    inputSchema: {
      text: z.string().describe("The new focus line (may be empty to clear)"),
      sticky: stickyOverride,
    },
  },
  async ({ text, sticky }) => {
    const doc = await load();
    const t = resolveTarget(doc, sticky);
    if (!t) return fail(NO_ACTIVE);
    t.sticky.focus = text;
    t.sticky.updated_at = now();
    await save(doc);
    return ok({ focus: t.sticky.focus, updated_at: t.sticky.updated_at });
  },
);

server.registerTool(
  "update",
  {
    description:
      "Minimal triage only: change an item's text, section, status, or rank. Not for bulk edits.",
    inputSchema: {
      id: z.string().min(1).describe("Item id"),
      text: z.string().min(1).optional(),
      section: z.enum(["priority", "inbox", "later"]).optional(),
      status: z.enum(["open", "done"]).optional(),
      rank: z.number().int().nullable().optional(),
      sticky: stickyOverride,
    },
  },
  async ({ id, text, section, status, rank, sticky }) => {
    const doc = await load();
    const t = resolveTarget(doc, sticky);
    if (!t) return fail(NO_ACTIVE);
    const item = t.sticky.items.find((i) => i.id === id);
    if (!item) return fail(`No item with id "${id}" in sticky "${t.slug}".`);
    if (text !== undefined) item.text = text;
    if (section !== undefined) item.section = section;
    if (rank !== undefined) item.rank = rank;
    if (status !== undefined) {
      item.status = status;
      item.completed_at = status === "done" ? now() : null;
    }
    t.sticky.updated_at = now();
    await save(doc);
    return ok({ item });
  },
);

// ---------- boot ----------

const transport = new StdioServerTransport();
await server.connect(transport);
