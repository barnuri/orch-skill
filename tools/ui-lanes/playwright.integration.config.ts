// Integration lane: Playwright against the compose stack that integration/run.ts starts. No webServer here:
// the stack is already up and ORCH_LANE_URL names its random host port.
import { defineConfig, devices } from "@playwright/test";

const url = process.env.ORCH_LANE_URL;
if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || url.endsWith(":6724")) {
  throw new Error(`integration lane: ORCH_LANE_URL must be http://127.0.0.1:<port> and not 6724, got ${url}`);
}

export default defineConfig({
  testDir: "./tests/integration",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: url, trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
