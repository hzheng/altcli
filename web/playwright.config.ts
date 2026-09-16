import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
// This token is only a test fixture, never a deployment credential.
const TOKEN = "a".repeat(64);
process.env.CODERCREW_TOKEN = TOKEN;
// Each viewport project gets its own server and store: hook events and history must not leak between them.
const server = (port: number, name: string) => ({
  command: `npx next dev --hostname 127.0.0.1 --port ${port}`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false,
  env: { CODERCREW_TOKEN: TOKEN, CODERCREW_ADAPTER: "mock", CODERCREW_ENABLE_INPUT: "true",
    CODERCREW_DATA_DIR: join(tmpdir(), `codercrew-e2e-${process.pid}-${port}`), CODERCREW_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
    CODERCREW_DIST_DIR: `.next-e2e-${name}` },
});
// Two consecutive ports, so the suite can run beside a dev console on 8787: CODERCREW_E2E_PORT=9787 npm run e2e
const base = Number(process.env.CODERCREW_E2E_PORT ?? 8787);
export default defineConfig({
  testDir: "./e2e", fullyParallel: false, workers: 1,
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${base}` } },
    { name: "iphone", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium", baseURL: `http://127.0.0.1:${base + 1}` } },
  ],
  webServer: [server(base, "desktop"), server(base + 1, "iphone")],
});
