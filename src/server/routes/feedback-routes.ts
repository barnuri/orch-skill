import { readJsonBody } from "../http/body";
import { jsonResponse } from "../http/responses";
import type { RouteHandler } from "../http/route";
import type { ServerContext } from "../types/server-context";
import { dispatchPath } from "../dispatch-path";
import { parseJsonStrict } from "../validation/strict-json";
import { MAX_BODY_BYTES } from "./document-routes";
import {
  addFeedback, filterFeedback, getFeedback, isKind, isSource, isStatus, readFeedback, updateFeedback,
  type FeedbackPatch,
} from "../../../skills/orch/core/feedback.ts";

const FEEDBACK_ID = /^fb-\d{8}-\d+$/;
const MAX_FEEDBACK_TEXT = 8000;

type Json = Record<string, unknown>;

// The body must be a JSON object. On failure returns the 400 response to send.
function objectBody(text: string): { obj: Json } | { error: Response } {
  const parsed = parseJsonStrict(text);
  if (!parsed.ok) return { error: jsonResponse(400, { error: `invalid JSON: ${parsed.error}` }) };
  if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
    return { error: jsonResponse(400, { error: "body must be a JSON object" }) };
  }
  return { obj: parsed.value as Json };
}

function optionalString(obj: Json, key: string): string | undefined | "bad" {
  const v = obj[key];
  if (v === undefined) return undefined;
  return typeof v === "string" ? v : "bad";
}

export function listFeedbackHandler(ctx: ServerContext): RouteHandler {
  return (req: Request): Response => {
    const status = new URL(req.url).searchParams.get("status") ?? undefined;
    if (status !== undefined && !isStatus(status)) {
      return jsonResponse(400, { error: `bad status "${status}" (new|queued|working|done|wontfix)` });
    }
    return jsonResponse(200, { items: filterFeedback(readFeedback(ctx.paths.home), { status }) });
  };
}

export function createFeedbackHandler(ctx: ServerContext): RouteHandler {
  return async (req: Request): Promise<Response> => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) return body.response;
    const parsed = objectBody(body.text);
    if ("error" in parsed) return parsed.error;
    const o = parsed.obj;
    if (typeof o["text"] !== "string") return jsonResponse(400, { error: "text must be a string" });
    if (o["text"].length > MAX_FEEDBACK_TEXT) return jsonResponse(400, { error: `text is longer than ${MAX_FEEDBACK_TEXT} characters` });
    const source = o["source"] ?? "ui";
    const kind = o["kind"] ?? "other";
    if (!isSource(source)) return jsonResponse(400, { error: `bad source "${String(source)}" (chat|cli|ui)` });
    if (!isKind(kind)) return jsonResponse(400, { error: `bad kind "${String(kind)}" (bug|idea|ux|other)` });
    const chat_id = optionalString(o, "chat_id");
    const run_id = optionalString(o, "run_id");
    const node_id = optionalString(o, "node_id");
    if ([chat_id, run_id, node_id].includes("bad")) return jsonResponse(400, { error: "chat_id, run_id and node_id must be strings" });
    try {
      const item = addFeedback(ctx.paths.home, {
        text: o["text"] as string, source, kind,
        chat_id: chat_id as string | undefined, run_id: run_id as string | undefined, node_id: node_id as string | undefined,
      }, new Date().toISOString().replace(/\.\d+Z$/, "Z"));
      return jsonResponse(201, { item });
    } catch (e) {
      return jsonResponse(400, { error: (e as Error).message });
    }
  };
}

export function updateFeedbackHandler(ctx: ServerContext): RouteHandler {
  return async (req: Request, params: Readonly<Record<string, string>>): Promise<Response> => {
    const id = params["id"] ?? "";
    if (!FEEDBACK_ID.test(id)) return jsonResponse(404, { error: `no feedback ${id}` });
    if (!getFeedback(ctx.paths.home, id)) return jsonResponse(404, { error: `no feedback ${id}` });
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) return body.response;
    const parsed = objectBody(body.text);
    if ("error" in parsed) return parsed.error;
    const status = parsed.obj["status"];
    const result = optionalString(parsed.obj, "result");
    const work_run = optionalString(parsed.obj, "work_run");
    if (result === "bad" || work_run === "bad") return jsonResponse(400, { error: "result and work_run must be strings" });
    const patch: FeedbackPatch = {};
    if (status !== undefined) {
      if (!isStatus(status)) return jsonResponse(400, { error: `bad status "${String(status)}" (new|queued|working|done|wontfix)` });
      patch.status = status;
    }
    if (result !== undefined) patch.result = result;
    if (work_run !== undefined) patch.work_run = work_run;
    if (Object.keys(patch).length === 0) return jsonResponse(400, { error: "give status, result or work_run" });
    try {
      return jsonResponse(200, { item: updateFeedback(ctx.paths.home, id, patch, new Date().toISOString().replace(/\.\d+Z$/, "Z")) });
    } catch (e) {
      return jsonResponse(400, { error: (e as Error).message });
    }
  };
}

// Runs the batch in the CLI, with this server's home. The run functions read the home from the
// environment, so an in-process call would write runs to the process home, not to ctx.paths.home.
export function workFeedbackHandler(ctx: ServerContext): RouteHandler {
  return async (req: Request): Promise<Response> => {
    const body = await readJsonBody(req, MAX_BODY_BYTES, true);
    if (!body.ok) return body.response;
    const args = ["feedback", "work", "--json"];
    if (body.text.trim() !== "") {
      const parsed = objectBody(body.text);
      if ("error" in parsed) return parsed.error;
      const ids = parsed.obj["ids"];
      if (ids !== undefined) {
        if (!Array.isArray(ids) || ids.length === 0 || !ids.every((i) => typeof i === "string" && FEEDBACK_ID.test(i))) {
          return jsonResponse(400, { error: "ids must be a non-empty list of feedback ids (fb-yyyymmdd-n)" });
        }
        args.push("--ids", (ids as string[]).join(","));
      }
    }
    const proc = Bun.spawn([process.execPath, dispatchPath(), ...args], {
      env: { ...process.env, HARNESS_ORCH_HOME: ctx.paths.home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    const text = stdout.trim();
    const err = stderr.trim();
    if (exitCode !== 0) return jsonResponse(400, { error: err || text || `feedback work exited ${exitCode}` });
    const parsed = parseJsonStrict(text);
    if (!parsed.ok) return jsonResponse(500, { error: `invalid feedback work output: ${parsed.error}` });
    return jsonResponse(200, parsed.value as Json);
  };
}
