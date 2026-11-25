// Headed proof lane: the mock lane in a visible Chromium window, recording video, trace and screenshots.
// Artifacts go to ORCH_PROOF_DIR (default .out/proof). No live service, no orch home.
import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const port = Number(process.env.ORCH_MOCK_PORT ?? 5175);
if (!Number.isInteger(port) || port <= 0 || port === 6724) {
  throw new Error(`proof lane: ORCH_MOCK_PORT must be a port other than 6724, got ${process.env.ORCH_MOCK_PORT}`);
}
const outDir = resolve(process.env.ORCH_PROOF_DIR ?? ".out/proof");

export default defineConfig({
  testDir: "./tests/proof",
  outputDir: `${outDir}/results`,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [["list"], ["json", { outputFile: `${outDir}/report.json` }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: false,
    video: "on",
    trace: "on",
    screenshot: "on",
    launchOptions: { slowMo: 250 },
  },
  projects: [
    {
      name: "chromium-headed",
      // The installed Google Chrome by default: the headed run needs no Playwright browser download.
      use: { ...devices["Desktop Chrome"], headless: false, channel: process.env.ORCH_PROOF_CHANNEL ?? "chrome" },
    },
  ],
  webServer: {
    command: "bun mock/serve.ts",
    url: `http://127.0.0.1:${port}`,
    env: { ORCH_MOCK_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
