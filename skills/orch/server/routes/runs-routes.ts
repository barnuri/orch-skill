import { resolve } from "node:path";

import type { ApiError } from "../../shared/types/api-error";
import type { ChatEnvelope } from "../../shared/types/chat-envelope";
import type { JobLogEnvelope } from "../../shared/types/job-log-envelope";
import type { RunEnvelope } from "../../shared/types/run-envelope";
import type { RunsEnvelope } from "../../shared/types/runs-envelope";
import { etagOf } from "../documents/document-store";
import type { RouteHandler } from "../http/route";
import { jsonResponse, notFound, notModified } from "../http/responses";
import { readJobLog, readJobSession } from "../runs/job-log-reader";
import { readRun, listRuns } from "../runs/runs-reader";
import { SessionChatReader } from "../runs/session-chat-reader";
import type { ServerContext } from "../types/server-context";

const IF_NONE_MATCH: string = "if-none-match";
const ETAG_HEADER: string = "ETag";
const CORRUPT_STATE: string = "state.json is not valid JSON";
const DISPATCH: string = resolve(import.meta.dir, "../../scripts/dispatch.sh");

// The ETag covers the payload only — never `generated_at` — so an unchanged runs/ tree yields a 304.
function payloadEtag(payload: unknown): string {
  return etagOf(new TextEncoder().encode(JSON.stringify(payload)));
}

export function listRunsHandler(ctx: ServerContext): RouteHandler {
  return (req: Request): Response => {
    const runs = listRuns(ctx.paths);
    const etag = payloadEtag(runs);
    if (req.headers.get(IF_NONE_MATCH) === etag) {
      return notModified(etag);
    }
    const body: RunsEnvelope = { generated_at: new Date().toISOString(), runs };
    return jsonResponse(200, body, { [ETAG_HEADER]: etag });
  };
}

// `params.id` arrives percent-decoded from Bun; `readRun` rejects anything outside the id alphabet.
export function readRunHandler(ctx: ServerContext): RouteHandler {
  return (req: Request, params: Readonly<Record<string, string>>): Response => {
    const result = readRun(ctx.paths, params.id ?? "");
    if (result.kind === "missing") {
      return notFound();
    }
    if (result.kind === "corrupt") {
      const error: ApiError = { error: CORRUPT_STATE };
      return jsonResponse(500, error);
    }
    const etag = payloadEtag(result.run);
    if (req.headers.get(IF_NONE_MATCH) === etag) {
      return notModified(etag);
    }
    const body: RunEnvelope = { generated_at: new Date().toISOString(), run: result.run };
    return jsonResponse(200, body, { [ETAG_HEADER]: etag });
  };
}

// Runs dispatch.sh without blocking the event loop; the handler resolves once the script exits.
async function dispatchSubcommand(ctx: ServerContext, args: readonly string[]): Promise<Response> {
  const proc = Bun.spawn(["bash", DISPATCH, ...args], {
    env: { ...process.env, HARNESS_ORCH_HOME: ctx.paths.home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).arrayBuffer(),
    proc.exited,
  ]);
  const text = new TextDecoder().decode(stdoutBytes).trim();
  const err = new TextDecoder().decode(stderrBytes).trim();
  if (exitCode !== 0) {
    const error: ApiError = { error: err || text || `dispatch exited ${exitCode}` };
    return jsonResponse(exitCode === 2 ? 400 : 500, error);
  }
  return jsonResponse(200, { ok: true, output: text });
}

function runVerbHandler(ctx: ServerContext, verb: string): RouteHandler {
  return (_req: Request, params: Readonly<Record<string, string>>): Promise<Response> | Response => {
    const id = params.id ?? "";
    if (id === "") {
      return jsonResponse(400, { error: "missing run id" });
    }
    return dispatchSubcommand(ctx, ["run", verb, id]);
  };
}

export function retryRunHandler(ctx: ServerContext): RouteHandler {
  return runVerbHandler(ctx, "retry");
}

export function stopRunHandler(ctx: ServerContext): RouteHandler {
  return runVerbHandler(ctx, "stop");
}

export function retryNodeHandler(ctx: ServerContext): RouteHandler {
  return (_req: Request, params: Readonly<Record<string, string>>): Promise<Response> | Response => {
    const runId = params.id ?? "";
    const nodeId = params.node ?? "";
    if (runId === "" || nodeId === "") {
      return jsonResponse(400, { error: "missing run or node id" });
    }
    return dispatchSubcommand(ctx, ["node", "retry", runId, nodeId]);
  };
}

/**
 * A node's whole transcript, so the dashboard can show the session rather than the tail.
 * Served per job id — the dashboard reads that off the node it is displaying.
 */
export function readJobLogHandler(ctx: ServerContext): RouteHandler {
  return (req: Request, params: Readonly<Record<string, string>>): Response => {
    const jobId = params.id ?? "";
    const result = readJobLog(ctx.paths, jobId);
    if (result.kind === "invalid" || result.kind === "missing") {
      return notFound();
    }
    const body: JobLogEnvelope = {
      job_id: jobId,
      session: readJobSession(ctx.paths, jobId),
      text: result.text,
      truncated: result.truncated,
      bytes: result.bytes,
    };
    const etag = payloadEtag(body);
    if (req.headers.get(IF_NONE_MATCH) === etag) {
      return notModified(etag);
    }
    return jsonResponse(200, body, { [ETAG_HEADER]: etag });
  };
}

/** Serves the job's conversation; 404 means no session or no transcript, so the dashboard uses the log. */
export function readJobChatHandler(
  ctx: ServerContext,
  reader: SessionChatReader = new SessionChatReader(),
): RouteHandler {
  return (req: Request, params: Readonly<Record<string, string>>): Response => {
    const jobId = params.id ?? "";
    const session = readJobSession(ctx.paths, jobId);
    if (session === null) {
      return notFound();
    }
    const result = reader.read(session);
    if (result.kind !== "ok") {
      return notFound();
    }
    const body: ChatEnvelope = {
      job_id: jobId,
      session,
      turns: result.turns,
      truncated: result.truncated,
    };
    const etag = payloadEtag(body);
    if (req.headers.get(IF_NONE_MATCH) === etag) {
      return notModified(etag);
    }
    return jsonResponse(200, body, { [ETAG_HEADER]: etag });
  };
}
