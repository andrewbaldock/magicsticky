#!/usr/bin/env bun
// One-shot migration: import the retired Phase-1 JSON store (~/.magicsticky/store.json — focus +
// flat item list per sticky) into the Phase-2 SQLite store as free-text blobs, for a given account.
// Run ONCE per account at cutover so the hosted app doesn't launch empty (plan step 7).
//
// Usage:
//   bun run scripts/migrate-store.ts --user <userId> [--json ~/.magicsticky/store.json] [--shared <slug>]
//
// Each old sticky becomes one new sticky whose text is: the focus line, then each item as a
// "- text" line (done items struck with [x]). Does NOT auto-flip the shared sticky unless --shared
// names which old slug should be shared (else leaves the account's existing shared pointer alone).

import { homedir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { cipherFromEnv } from "../src/crypto.ts";

interface OldItem { text: string; status?: string }
interface OldSticky { title?: string; focus?: string; items?: OldItem[] }
interface OldDoc { active?: string | null; stickies?: Record<string, OldSticky> }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const userId = arg("user");
if (!userId) {
  console.error("Required: --user <userId>. (Find it in the account table / after sign-in.)");
  process.exit(1);
}
const jsonPath = arg("json") ?? join(homedir(), ".magicsticky", "store.json");
const shareSlug = arg("shared");
const dbPath = process.env.MAGICSTICKY_DB ?? "./magicsticky.db";

const file = Bun.file(jsonPath);
if (!(await file.exists())) {
  console.error(`No Phase-1 store at ${jsonPath} — nothing to migrate.`);
  process.exit(1);
}
const doc = (await file.json()) as OldDoc;
const stickies = doc.stickies ?? {};
const slugs = Object.keys(stickies);
if (slugs.length === 0) {
  console.log("Phase-1 store has no stickies — nothing to import.");
  process.exit(0);
}

// Flatten one old sticky (focus + items) into a single free-text blob.
function flatten(s: OldSticky): string {
  const lines: string[] = [];
  if (s.title) lines.push(s.title);
  if (s.focus) lines.push(s.focus);
  if (lines.length && s.items?.length) lines.push(""); // blank line before the list
  for (const it of s.items ?? []) {
    const mark = it.status === "done" ? "- [x] " : "- ";
    lines.push(mark + it.text);
  }
  return lines.join("\n");
}

const store = new Store(dbPath, cipherFromEnv(process.env.MAGICSTICKY_KEYS));

let imported = 0;
for (const slug of slugs) {
  const text = flatten(stickies[slug]);
  const makeShared = shareSlug === slug;
  store.create(userId, text, { shared: makeShared });
  console.log(`  imported "${slug}" (${text.length} chars)${makeShared ? " [shared]" : ""}`);
  imported++;
}
store.close();
console.log(`Done — imported ${imported} sticky(ies) for user ${userId} into ${dbPath}.`);
