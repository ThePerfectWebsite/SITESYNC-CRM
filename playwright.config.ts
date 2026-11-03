import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// E2E runs the production build against the disposable test database on its own port.
if (existsSync(".env")) process.loadEnvFile(".env");

const PORT = 3100;
const ORIGIN = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: ORIGIN,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npx next start -H 127.0.0.1 -p ${PORT}`,
    url: `${ORIGIN}/health`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: process.env.DATABASE_URL_TEST ?? "",
      SITESYNC_APP_ORIGIN: ORIGIN,
      SITESYNC_LAN_MODE: "false",
      SITESYNC_PUBLIC_ORIGIN: "",
      // Only for e2e/github.spec.ts: a webhook secret, and deliberately no GitHub token.
      E2E_GITHUB_WEBHOOK_SECRET: "e2e-webhook-secret",
    },
  },
});
