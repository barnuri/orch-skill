import { resolve } from "node:path";

import type { ProfileSanityEnvelope } from "../../shared/types/profile-sanity";
import type { ApiError } from "../../shared/types/api-error";
import { readJsonBody } from "../http/body";
import { jsonResponse } from "../http/responses";
import type { RouteHandler } from "../http/route";
import type { ServerContext } from "../types/server-context";
import { MAX_BODY_BYTES } from "./document-routes";
import { parseJsonStrict } from "../validation/strict-json";

const DISPATCH: string = resolve(import.meta.dir, "../../scripts/dispatch.sh");
/** Bounds a sweep so one wedged CLI cannot hold the request past the server's idle timeout. */
const SANITY_TIMEOUT_MS: number = 210_000;

/**
 * Spawned asynchronously on purpose: a full sanity sweep runs one real harness call per profile
 * and takes tens of seconds. `spawnSync` would block Bun's event loop for all of it, freezing
 * the 2 s poll and every other request until the last probe returned.
 */
async function dispatchSanity(args: readonly string[]): Promise<Response> {
  const proc = Bun.spawn(["bash", DISPATCH, ...args], {
    env: { ...process.env, HARNESS_ORCH_HOME: process.env["HARNESS_ORCH_HOME"] },
    stdout: "pipe",
    stderr: "pipe",
  });
  // `proc.killed` only reports that the process is no longer running, which is also true of a
  // clean exit — the timer has to record the kill itself.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, SANITY_TIMEOUT_MS);
  let stdout: string;
  let stderr: string;
  try {
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }
  const text = stdout.trim();
  const err = stderr.trim();
  if (timedOut) {
    const error: ApiError = { error: `sanity timed out after ${SANITY_TIMEOUT_MS / 1000}s` };
    return jsonResponse(504, error);
  }
  if (proc.exitCode !== 0) {
    const error: ApiError = { error: err || text || `dispatch exited ${proc.exitCode}` };
    return jsonResponse(500, error);
  }
  const parsed = parseJsonStrict(text);
  if (!parsed.ok) {
    const error: ApiError = { error: `invalid sanity output: ${parsed.error}` };
    return jsonResponse(500, error);
  }
  return jsonResponse(200, parsed.value as ProfileSanityEnvelope);
}

export function profileSanityHandler(_ctx: ServerContext): RouteHandler {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "method not allowed" });
    }
    const body = await readJsonBody(req, MAX_BODY_BYTES, true);
    if (!body.ok) {
      return body.response;
    }
    const args = ["profile", "sanity"];
    if (body.text.trim() !== "") {
      const parsed = parseJsonStrict(body.text);
      if (!parsed.ok) {
        return jsonResponse(400, { error: `invalid JSON: ${parsed.error}` });
      }
      const value = parsed.value;
      if (value !== null && typeof value === "object") {
        const profile = (value as Record<string, unknown>)["profile"];
        const profiles = (value as Record<string, unknown>)["profiles"];
        if (typeof profile === "string" && profile !== "") {
          args.push("--profile", profile);
        } else if (Array.isArray(profiles)) {
          for (const entry of profiles) {
            if (typeof entry === "string" && entry !== "") {
              args.push("--profile", entry);
            }
          }
        }
      }
    }
    return await dispatchSanity(args);
  };
}
