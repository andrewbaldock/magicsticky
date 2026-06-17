// Magic Sticky — storage. A single dumb JSON doc on disk, loaded/saved atomically.
// The data is dumb on purpose (SPEC §3): per sticky, a focus string + a flat list.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export type Section = "priority" | "inbox" | "later";
export type Status = "open" | "done";

export interface Item {
  id: string;
  text: string;
  section: Section;
  status: Status;
  rank: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface Sticky {
  title: string;
  focus: string;
  items: Item[];
  created_at: string;
  updated_at: string;
}

export interface StoreDoc {
  // the shared "active note" pointer — the glue across all your Claudes (SPEC §6)
  active: string | null;
  stickies: Record<string, Sticky>;
}

// Allow override for tests; default to ~/.magicsticky/store.json
const STORE_PATH =
  process.env.MAGICSTICKY_STORE ?? join(homedir(), ".magicsticky", "store.json");

function emptyDoc(): StoreDoc {
  return { active: null, stickies: {} };
}

export async function load(): Promise<StoreDoc> {
  const file = Bun.file(STORE_PATH);
  if (!(await file.exists())) return emptyDoc();
  try {
    const doc = (await file.json()) as StoreDoc;
    // be forgiving about a hand-edited or partial file
    return { active: doc.active ?? null, stickies: doc.stickies ?? {} };
  } catch {
    return emptyDoc();
  }
}

// Atomic write: write a temp file in the same dir, then rename over the target.
export async function save(doc: StoreDoc): Promise<void> {
  const dir = join(STORE_PATH, "..");
  await mkdir(dir, { recursive: true });
  const tmp = `${STORE_PATH}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  await rename(tmp, STORE_PATH);
}

// --- small helpers used by the tools ---

export function now(): string {
  return new Date().toISOString();
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function newItem(text: string, section: Section): Item {
  return {
    id: randomUUID(),
    text,
    section,
    status: "open",
    rank: null,
    created_at: now(),
    completed_at: null,
  };
}

export function openCount(s: Sticky): number {
  return s.items.filter((i) => i.status === "open").length;
}

export { STORE_PATH };
