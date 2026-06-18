import { defineConfig, devices } from "@playwright/test";

// E2E is a DEV/TEST tool only — never shipped, never part of the served app. It boots its OWN
// server (e2e/server.ts: the real Hono app + built UI, with Google sign-in stubbed) and drives the
// real UI in a real browser. Production (server-http.ts) knows nothing about any of this.
const PORT = 3199;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // single shared test server + db
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  // Mobile-first: an iPhone is the primary target (the SPEC's one-tap phone PWA).
  projects: [
    { name: "iphone", use: { ...devices["iPhone 14"] } },
    { name: "pixel", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `bun run e2e/server.ts`,
    port: PORT,
    reuseExistingServer: false,
    env: { E2E_PORT: String(PORT) },
  },
});
