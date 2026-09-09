import { resolve } from "node:path";

import type { HarnessesEnvelope } from "../../shared/types/harness-status";
import type { ApiError } from "../../shared/types/api-error";
import { jsonResponse } from "../http/responses";
import type { RouteHandler } from "../http/route";
import type { ServerContext } from "../types/server-context";
import { parseJsonStrict } from "../validation/strict-json";

const DISPATCH: string = resolve(import.meta.dir, "../../scripts/dispatch.sh");

export function listHarnessesHandler(_ctx: ServerContext): RouteHandler {
  return (): Response => {
    const proc = Bun.spawnSync(["bash", DISPATCH, "harness", "list", "--json"], {
      env: { ...process.env, HARNESS_ORCH_HOME: process.env["HARNESS_ORCH_HOME"] },
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = new TextDecoder().decode(proc.stdout).trim();
    const err = new TextDecoder().decode(proc.stderr).trim();
    if (proc.exitCode !== 0) {
      const error: ApiError = { error: err || text || `dispatch exited ${proc.exitCode}` };
      return jsonResponse(500, error);
    }
    const parsed = parseJsonStrict(text);
    if (!parsed.ok) {
      const error: ApiError = { error: `invalid harness output: ${parsed.error}` };
      return jsonResponse(500, error);
    }
    return jsonResponse(200, parsed.value as HarnessesEnvelope);
  };
}
