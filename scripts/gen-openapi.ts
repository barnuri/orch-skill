/**
 * Writes docs/openapi.json from buildApi without starting a listener.
 * Usage: bun scripts/gen-openapi.ts [outfile]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { buildApi, OPENAPI_PATH } from "../src/server/api/build-api";
import { digestToken } from "../src/server/http/auth";
import { orchPaths } from "../src/server/files/paths";

export const DEFAULT_OUT: string = resolve(import.meta.dir, "../docs/openapi.json");

/** The generated document, with a fixed context so the output is stable across machines. */
export async function generateOpenApi(): Promise<string> {
  const api = buildApi({
    paths: orchPaths(join(tmpdir(), "orch-openapi-home")),
    bindHost: "127.0.0.1",
    hostname: "localhost",
    tokenDigest: digestToken("openapi-doc"),
    requireToken: true,
    requireRemoteToken: true,
    harnesses: ["claude", "cursor-agent", "opencode", "local-llm", "copilot", "pi"],
    outcomes: ["success", "failure", "partial"],
  });
  const res = await api.fetch(
    new Request(`http://localhost${OPENAPI_PATH}`, { headers: { Host: "localhost", Authorization: "Bearer openapi-doc" } }),
    { server: { requestIP: () => ({ address: "127.0.0.1" }) } } as never,
  );
  if (res.status !== 200) {
    throw new Error(`openapi route answered ${res.status}`);
  }
  return `${JSON.stringify(await res.json(), null, 2)}\n`;
}

if (import.meta.main) {
  const out = resolve(process.argv[2] ?? DEFAULT_OUT);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await generateOpenApi());
  console.log(out);
}
