import { defineConfig, devices } from "@playwright/test";

const live = process.env.REQUIRE_LIVE_MODEL === "true";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "tablet-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 768 } }, grep: /@responsive/ },
    { name: "mobile-chromium", use: { ...devices["iPhone 13"], browserName: "chromium" }, grep: /@responsive/ },
  ],
  webServer: {
    command: live ? "npm run dev:test" : "DISABLE_LIVE_MODEL=true npm run dev:test",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
