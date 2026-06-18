// Offline catch-up E2E: go offline → banner + TEXT/CLAUDE choice → capture a note → back online →
// it flushes (appends to a sticky, below the divider). Uses Playwright's real offline emulation.

import { test, expect, type Page } from "@playwright/test";

let seq = 0;
async function signIn(page: Page, draft?: string) {
  const email = `offline-${Date.now()}-${seq++}@example.com`;
  const res = await page.request.post("/auth/google", { data: { credential: `e2e:${email}`, draft } });
  expect(res.status()).toBe(200);
}

test("offline → capture a text note → back online → it syncs (appends below the divider)", async ({
  page,
  context,
}) => {
  await signIn(page, "my first note"); // seeds sticky-1 (shared); we'll need a non-shared target too
  await page.goto("/");
  await page.locator(".editor").waitFor();

  // create a second (non-shared) sticky so the TEXT note has a lowest-non-shared target
  await page.locator(".tab-add").click();
  await expect(page.locator(".tab")).toHaveCount(2);

  // go offline → the offline bar appears
  await context.setOffline(true);
  await expect(page.locator(".offline-bar")).toBeVisible();
  await expect(page.locator(".offline-bar")).toContainText("Offline");

  // choose TEXT NOTE and type
  await page.getByRole("button", { name: /Text note/i }).click();
  await page.locator(".offline-input").fill("buy milk offline");

  // back online → useOffline flushes; the bar goes away once synced
  await context.setOffline(false);
  await expect(page.locator(".offline-bar")).toBeHidden({ timeout: 6000 });

  // verify it landed: some sticky now contains the divider + the note (read via the API)
  const { stickies } = await (await page.request.get("/api/stickies")).json();
  let found = false;
  for (const s of stickies as Array<{ id: string }>) {
    const full = await (await page.request.get(`/api/stickies/${s.id}`)).json();
    if (full.text.includes("pwa catch-up") && full.text.includes("buy milk offline")) found = true;
  }
  expect(found).toBe(true);
});

test("offline bar is hidden while online with nothing pending", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await page.locator(".editor").waitFor();
  await expect(page.locator(".offline-bar")).toHaveCount(0);
});
