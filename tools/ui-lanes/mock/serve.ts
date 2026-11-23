#!/usr/bin/env bun
// Starts the fast mock lane dev server. Usage: bun tools/ui-lanes/mock/serve.ts  (ORCH_MOCK_PORT optional).
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const server = await createServer({ configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)) });
await server.listen();
server.printUrls();
