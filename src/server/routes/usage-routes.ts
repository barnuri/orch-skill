import { dispatchPath } from "../dispatch-path";

import type { ApiError } from "../../shared/types/api-error";
import { choiceFromUsage, profileUsage, harnessUsage, type UsageChoice } from "../../shared/profile-usage";
import { jsonResponse } from "../http/responses";
import type { ServerContext } from "../types/server-context";
import { readProfiles } from "../chats/options";

export type UsageKind = "profile" | "harness";

/** The single state writer: `dispatch.ts profile|harness set-usage`. Answers 404 for an unknown name, 400 otherwise on a refusal. */
export async function setUsage(ctx: ServerContext, kind: UsageKind, id: string, choice: UsageChoice): Promise<Response> {
  const proc = Bun.spawn([process.execPath, dispatchPath(), kind, "set-usage", id, choice], {
    env: { ...process.env, HARNESS_ORCH_HOME: ctx.paths.home },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30000,
    killSignal: "SIGKILL",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    const message = err.trim() || out.trim() || `dispatch exited ${code}`;
    const body: ApiError = { error: message };
    return jsonResponse(/unknown (profile|harness)/.test(message) ? 404 : code === 2 ? 400 : 500, body);
  }
  const doc = readProfiles(ctx.paths.home);
  const usage = kind === "profile" ? profileUsage(doc, id) : harnessUsage(doc, id);
  return jsonResponse(200, { id, usage, choice: choiceFromUsage(usage) });
}
