import { dispatchPath } from "../dispatch-path";

import type { ApiError } from "../../shared/types/api-error";
import type { ScheduleInput, SchedulesEnvelope } from "../../shared/types/schedule";
import { etagOf } from "../documents/document-store";
import { jsonResponse, notModified } from "../http/responses";
import type { RouteHandler } from "../http/route";
import { readSchedules } from "../schedules/schedule-reader";
import type { ServerContext } from "../types/server-context";

const IF_NONE_MATCH: string = "if-none-match";
const SCHEDULE_ID: RegExp = /^sch-\d{8}-\d{6}-[0-9a-f]{4}$/;
const RUN_INDEX: RegExp = /^\d{1,3}$/;
const ACTIONS = ["run", "enable", "disable", "remove"] as const;
const MAX_TEXT: number = 20000;
const MAX_SHORT: number = 300;
const DURATION: RegExp = /^\d+[smhd]?$/;

interface Spawned {
  code: number;
  out: string;
  err: string;
}

export async function dispatchSchedule(ctx: ServerContext, args: readonly string[]): Promise<Spawned> {
  const proc = Bun.spawn(["bash", dispatchPath(), "schedule", ...args], {
    env: { ...process.env, HARNESS_ORCH_HOME: ctx.paths.home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

function fail(result: Spawned): Response {
  const error: ApiError = { error: result.err.trim() || result.out.trim() || `dispatch exited ${result.code}` };
  if (result.err.startsWith("unknown schedule")) {
    return jsonResponse(404, error);
  }
  return jsonResponse(result.code === 2 ? 400 : 500, error);
}

function badRequest(message: string): Response {
  const error: ApiError = { error: message };
  return jsonResponse(400, error);
}

export function listSchedulesHandler(ctx: ServerContext): RouteHandler {
  return (req: Request): Response => {
    const schedules = readSchedules(ctx.paths.home);
    const etag = etagOf(new TextEncoder().encode(JSON.stringify(schedules)));
    if (req.headers.get(IF_NONE_MATCH) === etag) {
      return notModified(etag);
    }
    const body: SchedulesEnvelope = { generated_at: new Date().toISOString(), schedules };
    return jsonResponse(200, body, { ETag: etag });
  };
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

// Every value reaches dispatch.sh as its own argv entry, never through a shell string.
function createArgs(body: Record<string, unknown>): string[] | string {
  const name = text(body["name"], MAX_SHORT);
  const cron = text(body["cron"], MAX_SHORT);
  if (name === null || cron === null) {
    return "name and cron are required";
  }
  const args = ["add", "--name", name, "--cron", cron];
  if (body["kind"] === "prompt") {
    const prompt = text(body["prompt"], MAX_TEXT);
    const profile = text(body["profile"], MAX_SHORT);
    if (prompt === null || profile === null) {
      return "a prompt schedule needs a prompt and a profile";
    }
    args.push("--prompt", prompt, "--profile", profile);
  } else if (body["kind"] === "command") {
    const command = text(body["command"], MAX_TEXT);
    if (command === null) {
      return "a command schedule needs a command";
    }
    args.push("--command", command);
    const workdir = text(body["workdir"], MAX_SHORT);
    if (workdir !== null) {
      args.push("--workdir", workdir);
    }
    const timeout = text(body["timeout"], 10);
    if (timeout !== null) {
      if (!DURATION.test(timeout)) {
        return "timeout must look like 30s, 5m or 1h";
      }
      args.push("--timeout", timeout);
    }
  } else {
    return "kind must be prompt or command";
  }
  return args;
}

/** Creates a schedule from an already-validated body (see ScheduleInputDto). */
export async function createSchedule(ctx: ServerContext, body: ScheduleInput): Promise<Response> {
  const args = createArgs(body as unknown as Record<string, unknown>);
  if (typeof args === "string") {
    return badRequest(args);
  }
  const result = await dispatchSchedule(ctx, args);
  if (result.code !== 0) {
    return fail(result);
  }
  return jsonResponse(201, { ok: true, id: result.out.trim() });
}

export function scheduleActionHandler(ctx: ServerContext): RouteHandler {
  return async (_req: Request, params: Readonly<Record<string, string>>): Promise<Response> => {
    const id = params.id ?? "";
    const action = params.action ?? "";
    if (!SCHEDULE_ID.test(id) || !(ACTIONS as readonly string[]).includes(action)) {
      return badRequest("invalid schedule id or action");
    }
    const result = await dispatchSchedule(ctx, [action, id]);
    return result.code === 0 ? jsonResponse(200, { ok: true }) : fail(result);
  };
}

// Validates a cron expression and names its next run, so the form can show it while you type.
export function schedulePreviewHandler(ctx: ServerContext): RouteHandler {
  return async (req: Request): Promise<Response> => {
    const cron = new URL(req.url).searchParams.get("cron") ?? "";
    if (cron.trim() === "" || cron.length > MAX_SHORT) {
      return badRequest("enter a cron expression");
    }
    const result = await dispatchSchedule(ctx, ["next", cron.trim()]);
    if (result.code !== 0) {
      return badRequest("not a valid cron expression (m h dom mon dow)");
    }
    return jsonResponse(200, { next: result.out.trim() });
  };
}

export function scheduleRunLogHandler(ctx: ServerContext): RouteHandler {
  return async (_req: Request, params: Readonly<Record<string, string>>): Promise<Response> => {
    const id = params.id ?? "";
    const index = params.index ?? "";
    if (!SCHEDULE_ID.test(id) || !RUN_INDEX.test(index)) {
      return badRequest("invalid schedule id or run index");
    }
    const result = await dispatchSchedule(ctx, ["log", id, index]);
    return result.code === 0 ? jsonResponse(200, { text: result.out }) : fail(result);
  };
}
