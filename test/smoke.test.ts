// End-to-end smoke test: spins up the real stdio MCP server as a child process
// and drives it through the full loop via the SDK client. Proves the tool wiring,
// not just internal functions (CLAUDE.md: "Run it. Exercise all the tools.").

import { test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let storeDir: string;
let client: Client;
let transport: StdioClientTransport;

// Tools return JSON-as-text; unwrap to the parsed payload.
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "magicsticky-test-"));
  transport = new StdioClientTransport({
    command: "bun",
    args: ["run", join(import.meta.dir, "..", "src", "server.ts")],
    env: { ...process.env, MAGICSTICKY_STORE: join(storeDir, "store.json") },
  });
  client = new Client({ name: "smoke-test", version: "0.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  await rm(storeDir, { recursive: true, force: true });
});

test("advertises the 'call whoami first' convention via server instructions", async () => {
  // The convention has to cross the client boundary, so it must ride the
  // initialize response — not just CLAUDE.md (which a remote client never sees).
  const instructions = client.getInstructions();
  expect(instructions).toBeTruthy();
  expect(instructions?.toLowerCase()).toContain("whoami");
});

test("exposes exactly the nine Phase-1 tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  expect(names).toEqual(
    [
      "add",
      "complete",
      "create_sticky",
      "get_list",
      "list_stickies",
      "set_focus",
      "update",
      "use_sticky",
      "whoami",
    ].sort(),
  );
});

test("full loop: create → use → add → get_list → complete → whoami", async () => {
  // create_sticky makes it active and returns its URL
  const created = await call("create_sticky", { slug: "jobhunt", title: "Job hunt" });
  expect(created.sticky).toBe("jobhunt");
  expect(created.url).toContain("jobhunt");

  // use_sticky is idempotent here but proves the glue pointer works
  const used = await call("use_sticky", { slug: "jobhunt" });
  expect(used.sticky).toBe("jobhunt");

  // set the focus and confirm whoami reflects it
  await call("set_focus", { text: "Interviewing; General Medicine Fri 6/19." });

  // capture with only text (one-step capture), and one into priority
  const a = await call("add", { text: "Mock interview run-through" });
  expect(a.item.section).toBe("inbox");
  expect(a.item.status).toBe("open");
  await call("add", { text: "Buy interview clothes", section: "priority" });

  // get_list shows both, priority sorted ahead of inbox
  const list = await call("get_list", {});
  expect(list.items.length).toBe(2);
  expect(list.items[0].section).toBe("priority");

  // complete the first inbox item
  const done = await call("complete", { id: a.item.id });
  expect(done.item.status).toBe("done");
  expect(done.item.completed_at).not.toBeNull();

  // whoami reflects focus + remaining open count (2 added, 1 completed → 1 open)
  const me = await call("whoami", {});
  expect(me.sticky).toBe("jobhunt");
  expect(me.focus).toBe("Interviewing; General Medicine Fri 6/19.");
  expect(me.open_count).toBe(1);

  // get_list filters
  const openOnly = await call("get_list", { status: "open" });
  expect(openOnly.items.length).toBe(1);
  const doneOnly = await call("get_list", { status: "done" });
  expect(doneOnly.items.length).toBe(1);
});

test("update performs triage and toggles completion timestamp", async () => {
  const a = await call("add", { text: "temp item" });
  const moved = await call("update", { id: a.item.id, section: "later", rank: 3 });
  expect(moved.item.section).toBe("later");
  expect(moved.item.rank).toBe(3);

  const reopened = await call("update", { id: a.item.id, status: "done" });
  expect(reopened.item.completed_at).not.toBeNull();
  const undone = await call("update", { id: a.item.id, status: "open" });
  expect(undone.item.completed_at).toBeNull();
});

test("sticky override acts on another note without moving the active pointer", async () => {
  await call("create_sticky", { slug: "house" }); // create_sticky moves active → house
  await call("use_sticky", { slug: "jobhunt" }); // move it back

  // add to house via override; active stays jobhunt
  await call("add", { text: "Fix toilet", sticky: "house" });
  const houseList = await call("get_list", { sticky: "house" });
  expect(houseList.items.some((i: { text: string }) => i.text === "Fix toilet")).toBe(true);

  const me = await call("whoami", {});
  expect(me.sticky).toBe("jobhunt"); // pointer never moved
});

test("list_stickies reports counts and the active flag", async () => {
  const { stickies, active } = await call("list_stickies", {});
  expect(active).toBe("jobhunt");
  const slugs = stickies.map((s: { slug: string }) => s.slug).sort();
  expect(slugs).toEqual(["house", "jobhunt"]);
  expect(stickies.find((s: { slug: string }) => s.slug === "jobhunt").active).toBe(true);
});

test("per-sticky tools fail cleanly when no sticky is active and none passed", async () => {
  // fresh server with an empty store
  const freshDir = await mkdtemp(join(tmpdir(), "magicsticky-empty-"));
  const t = new StdioClientTransport({
    command: "bun",
    args: ["run", join(import.meta.dir, "..", "src", "server.ts")],
    env: { ...process.env, MAGICSTICKY_STORE: join(freshDir, "store.json") },
  });
  const c = new Client({ name: "smoke-empty", version: "0.0.0" });
  await c.connect(t);
  const res = (await c.callTool({ name: "whoami", arguments: {} })) as { isError?: boolean };
  expect(res.isError).toBe(true);
  await c.close();
  await rm(freshDir, { recursive: true, force: true });
});
