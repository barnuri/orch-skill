// POST /api/cli on <home>/serve/orch.sock: runs an orch core command in this process and returns its
// output. The CLI tries this first and runs the same core function itself when it is unreachable.
// The socket is guarded by the 0700 serve/ directory, so it needs no token.
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { isSocketable, main as coreMain } from "../../skills/orch/core/cli.ts";
import { captured } from "../../skills/orch/core/io.ts";

export const CLI_SOCKET_NAME = "orch.sock";

interface CliRequest {
  argv: string[];
  env?: Record<string, string>;
}

function parse(body: unknown): CliRequest | null {
  const b = body as CliRequest;
  if (!b || !Array.isArray(b.argv) || !b.argv.every((a) => typeof a === "string")) return null;
  return { argv: b.argv, env: typeof b.env === "object" && b.env ? b.env : {} };
}

export function startCliSocket(home: string): { stop: () => void } | null {
  const dir = join(home, "serve");
  const path = join(dir, CLI_SOCKET_NAME);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const server = Bun.serve({
      unix: path,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method !== "POST" || url.pathname !== "/api/cli") return new Response("not found", { status: 404 });
        const parsed = parse(await req.json().catch(() => null));
        if (!parsed) return Response.json({ error: "argv must be a string array" }, { status: 400 });
        if (!isSocketable(parsed.argv)) return Response.json({ error: "command not served" }, { status: 400 });
        const result = await captured({ ...parsed.env, HARNESS_ORCH_HOME: home }, () => coreMain(parsed.argv, { direct: true }));
        return Response.json(result);
      },
    });
    try {
      chmodSync(path, 0o600);
    } catch {}
    return { stop: () => void server.stop(true) };
  } catch (e) {
    process.stderr.write(`serve: cli socket not started: ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
}
