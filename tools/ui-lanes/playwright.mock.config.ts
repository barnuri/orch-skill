// Fast mock lane: Playwright against the Vite dev server with the in-memory API. No live service, no orch home.
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.ORCH_MOCK_PORT ?? 5174);
if (!Number.isInteger(port) || port <= 0 || port === 6724) {
  throw new Error(`mock lane: ORCH_MOCK_PORT must be a port other than 6724, got ${process.env.ORCH_MOCK_PORT}`);
}

export default defineConfig({
  testDir: "./tests/mock",
  timeout: 60_000,
  // Vite compiles dependencies on the first request after a cache change; 5 s is too short for that.
  expect: { timeout: 20_000 },
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun mock/serve.ts",
    url: `http://127.0.0.1:${port}`,
    env: { ORCH_MOCK_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
