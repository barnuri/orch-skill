// Fast mock lane: Vite dev server over src/web, /api answered in memory. Port from ORCH_MOCK_PORT
// (default 5174). Refuses 6724, the live orch port, so it can never shadow the live service.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { orchMockApi } from "./vite-plugin";

const LIVE_PORT = 6724;
const DEFAULT_MOCK_PORT = 5174;
const port = Number(process.env.ORCH_MOCK_PORT ?? DEFAULT_MOCK_PORT);
if (!Number.isInteger(port) || port <= 0 || port === LIVE_PORT) {
  throw new Error(`ui-lanes mock: ORCH_MOCK_PORT must be a port other than ${LIVE_PORT}, got ${process.env.ORCH_MOCK_PORT}`);
}

export default defineConfig({
  root: fileURLToPath(new URL("../../../src/web", import.meta.url)),
  plugins: [orchMockApi()],
  server: { host: "127.0.0.1", port, strictPort: true },
  build: { outDir: fileURLToPath(new URL("../.out/mock-dist", import.meta.url)), emptyOutDir: true },
});
