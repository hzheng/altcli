import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
// This token is only a test fixture, never a deployment credential.
const TOKEN = "a".repeat(64);
process.env.CODERCREW_TOKEN = TOKEN;
// Each viewport project gets its own server and store: hook events and history must not leak between them.
const server = (port: number) => ({
  command: `npx next dev --hostname 127.0.0.1 --port ${port}`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false,
  env: { CODERCREW_TOKEN: TOKEN, CODERCREW_ADAPTER: "mock", CODERCREW_ENABLE_INPUT: "true",
    CODERCREW_DATA_DIR: join(tmpdir(), `codercrew-e2e-${process.pid}-${port}`), CODERCREW_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
    CODERCREW_DIST_DIR: `.next-e2e-${port}` },
});
export default defineConfig({
  testDir: "./e2e", fullyParallel: false, workers: 1,
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:8787" } },
    { name: "iphone", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium", baseURL: "http://127.0.0.1:8788" } },
  ],
  webServer: [server(8787), server(8788)],
});
