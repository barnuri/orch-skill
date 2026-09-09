import { resolve } from "node:path";

import type { ApiError } from "../../shared/types/api-error";
import type { SuggestionApplyEnvelope } from "../../shared/types/suggestion-apply-envelope";
import { readJsonBody } from "../http/body";
import { getDocumentHandler, putDocumentHandler, MAX_BODY_BYTES } from "./document-routes";
import { jsonResponse } from "../http/responses";
import type { RouteHandler } from "../http/route";
import type { ServerContext } from "../types/server-context";
import { parseJsonStrict } from "../validation/strict-json";

const DISPATCH: string = resolve(import.meta.dir, "../../scripts/dispatch.sh");

function dispatchSubcommand(args: readonly string[]): Response {
  const proc = Bun.spawnSync(["bash", DISPATCH, ...args], {
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
  return jsonResponse(200, { ok: true, output: text });
}

function dispatchApply(args: readonly string[]): Response {
  const proc = Bun.spawnSync(["bash", DISPATCH, ...args], {
    env: { ...process.env, HARNESS_ORCH_HOME: process.env["HARNESS_ORCH_HOME"] },
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = new TextDecoder().decode(proc.stdout).trim();
  const err = new TextDecoder().decode(proc.stderr).trim();
  if (text === "") {
    const error: ApiError = { error: err || `dispatch exited ${proc.exitCode}` };
    return jsonResponse(500, error);
  }
  const parsed = parseJsonStrict(text);
  if (!parsed.ok) {
    const error: ApiError = { error: `invalid apply output: ${parsed.error}` };
    return jsonResponse(500, error);
  }
  const status = proc.exitCode === 0 ? 200 : 207;
  return jsonResponse(status, parsed.value as SuggestionApplyEnvelope);
}

export function getSuggestionsHandler(ctx: ServerContext): RouteHandler {
  return getDocumentHandler(ctx, "suggestions");
}

export function putSuggestionsHandler(ctx: ServerContext): RouteHandler {
  return putDocumentHandler(ctx, "suggestions");
}

export function scanSuggestionsHandler(_ctx: ServerContext): RouteHandler {
  return (): Response => dispatchSubcommand(["suggest", "scan"]);
}

export function bulkApplySuggestionsHandler(_ctx: ServerContext): RouteHandler {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "method not allowed" });
    }
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      return body.response;
    }
    const args = ["suggest", "apply", "--json"];
    if (body.text.trim() !== "") {
      const parsed = parseJsonStrict(body.text);
      if (!parsed.ok) {
        return jsonResponse(400, { error: `invalid JSON: ${parsed.error}` });
      }
      const value = parsed.value;
      if (value !== null && typeof value === "object") {
        const all = (value as Record<string, unknown>)["all"];
        const ids = (value as Record<string, unknown>)["ids"];
        if (all === true) {
          args.push("--all");
        } else if (Array.isArray(ids)) {
          for (const entry of ids) {
            if (typeof entry === "string" && entry !== "") {
              args.push("--id", entry);
            }
          }
        }
      }
    }
    if (args.length === 3) {
      return jsonResponse(400, { error: "missing ids or all" });
    }
    return dispatchApply(args);
  };
}

export function applySuggestionHandler(_ctx: ServerContext): RouteHandler {
  return (_req: Request, params: Readonly<Record<string, string>>): Response => {
    const id = params["id"];
    if (id === undefined || id === "") {
      return jsonResponse(400, { error: "missing suggestion id" });
    }
    return dispatchApply(["suggest", "apply", "--json", "--id", id]);
  };
}

export function dismissSuggestionHandler(_ctx: ServerContext): RouteHandler {
  return (_req: Request, params: Readonly<Record<string, string>>): Response => {
    const id = params["id"];
    if (id === undefined || id === "") {
      return jsonResponse(400, { error: "missing suggestion id" });
    }
    return dispatchSubcommand(["suggest", "dismiss", id]);
  };
}
