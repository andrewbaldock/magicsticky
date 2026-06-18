// Mobile-first E2E: drives the REAL React UI in a real browser at phone viewports. Verifies the
// flow AND the mobile-correctness checks (touch-target sizes, no horizontal overflow, the editor
// fits the visual viewport). Sign-in is done by hitting /auth/google directly (the stub accepts
// "e2e:<email>") so we skip Google's own screen, then load the app already-authenticated.

import { test, expect, type Page } from "@playwright/test";

// Sign in via the stubbed endpoint; the Set-Cookie lands in the context so the app sees a session.
// The email is made UNIQUE per test+project so runs never share an account in the one in-memory
// store (which would cross-contaminate the shared-sticky version and cause false 409s).
let seq = 0;
async function signIn(page: Page, draft?: string) {
  const email = `e2e-${Date.now()}-${seq++}@example.com`;
  const res = await page.request.post("/auth/google", {
    data: { credential: `e2e:${email}`, draft },
  });
  expect(res.status()).toBe(200);
}

test("signed-out landing shows the draft sticky and a sign-in CTA", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByPlaceholder("Type anything…")).toBeVisible();
  await expect(page.getByText("Magic Sticky", { exact: false })).toBeVisible();
});

test("full flow: sign in → sticky-1 titled from draft → edit/counter → add → share → token", async ({
  page,
}) => {
  await signIn(page, "interview prep\n- mock run\n- travel");
  await page.goto("/");

  // sticky 1 nav tab shows the derived first-line title and is the shared one
  const firstTab = page.locator(".tab").first();
  await expect(firstTab).toContainText("interview prep");
  await expect(firstTab.locator(".shared-dot")).toBeVisible();

  // the editor holds the draft; the lozenge says it's shared
  const editor = page.locator(".editor");
  await expect(editor).toHaveValue(/interview prep/);
  await expect(page.locator(".lozenge.is-shared")).toContainText("Shared prompt");

  // type and see the counter; assert the SETTLED save state (not the transient "Saving…", which a
  // 700ms debounce can flash past faster than the test samples).
  await editor.fill("interview prep — done");
  await expect(page.locator(".counter")).toContainText("/ 10,000");
  await expect(page.locator(".save-state")).toContainText("Saved", { timeout: 5000 });

  // add a second sticky → becomes active, untitled
  await page.locator(".tab-add").click();
  await expect(page.locator(".tab")).toHaveCount(2);

  // make the new one shared (lozenge flips)
  await page.locator(".lozenge").click();
  await expect(page.locator(".lozenge.is-shared")).toBeVisible();

  // connector token: open the sheet, generate, see an msk_ token
  await page.getByRole("button", { name: "Connect a Claude" }).click();
  await page.getByRole("button", { name: "Generate token" }).click();
  await expect(page.locator(".token-box code")).toContainText("msk_");
});

test("MOBILE: no horizontal overflow; editor fits the viewport", async ({ page }) => {
  await signIn(page, "a note");
  await page.goto("/");
  await page.locator(".editor").waitFor();

  // no horizontal scroll (content must not exceed the viewport width)
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientW = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollW).toBeLessThanOrEqual(clientW + 1);

  // the editor's bottom stays within the viewport height (sized via dvh/svh, not 100vh)
  const box = await page.locator(".editor").boundingBox();
  const vh = await page.evaluate(() => window.innerHeight);
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(vh + 1);
});

test("MOBILE: touch targets are >= 44px (tabs, lozenge, icon buttons)", async ({ page }) => {
  await signIn(page, "x");
  await page.goto("/");
  await page.locator(".editor").waitFor();

  for (const sel of [".tab", ".tab-add", ".icon-btn", ".lozenge"]) {
    const box = await page.locator(sel).first().boundingBox();
    expect(box, `${sel} present`).not.toBeNull();
    expect(box!.height, `${sel} height`).toBeGreaterThanOrEqual(43.5); // ~44px min target
  }
});
