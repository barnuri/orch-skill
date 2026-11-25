import { ServerInfoDto } from "../../shared/dto/server-info";
import type { z } from "zod";
import { ActiveEnvelopeDto } from "../../shared/dto/active";
import { BuildInfoDto, RestartAcceptedDto } from "../../shared/dto/build";
import type { BuildInfo } from "../../shared/types/build-info";
import { OkDto } from "../../shared/dto/common";
import { HarnessesEnvelopeDto, RunVerifyEnvelopeDto } from "../../shared/dto/runs";
import { UsageResultDto } from "../../shared/dto/usage";
import type { UsageChoice } from "../../shared/profile-usage";
import {
  ScheduleCreatedDto,
  ScheduleLogDto,
  SchedulePreviewDto,
  SchedulesEnvelopeDto,
} from "../../shared/dto/schedule";
import type { ApiError } from "../../shared/types/api-error";
import type { DocumentKind } from "../../shared/types/document-kind";
import type { ActiveEnvelope } from "../../shared/types/active-envelope";
import type { HarnessesEnvelope } from "../../shared/types/harness-status";
import { jobChatSchema, jobLogSchema, nodeActivitySchema, runMessagesSchema, runNodeSchema, runSchema, runsSchema } from "../runs/schemas";
import type { ScheduleEdit, ScheduleInput, SchedulesEnvelope } from "../../shared/types/schedule";
import { API_BASE } from "../lib/constants";
import type { ApiResult } from "./result";
import {
  errorSchema,
  memoryEnvelopeSchema,
  profilesEnvelopeSchema,
  putOkSchema,
  sanitySchema,
  suggestionApplySchema,
  suggestionsEnvelopeSchema,
} from "./schemas";
import type { LoadedEnvelope } from "./schemas";
import { connection } from "./status";
import type { StatusStore } from "./status";
import { getToken } from "./token";

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";

interface RequestOptions {
  etag?: string | null;
  ifMatch?: string;
  body?: unknown;
  /** A failure must not turn the freshness dot red (side fetches may 4xx on purpose); a success still counts as live. */
  quiet?: boolean;
}

/**
 * The DTO schemas validate at runtime, but zod infers array fields of a decorated DTO as `{}`; the
 * shared plain types (src/shared/types) are the compile-time contract, so the schema is narrowed to
 * them here. One cast per DTO, and each is exercised by the client tests against real payloads.
 */
function typed<T>(schema: unknown): z.ZodType<T> {
  return schema as z.ZodType<T>;
}

const activeSchema = typed<ActiveEnvelope>(ActiveEnvelopeDto.schema);
const buildSchema = typed<BuildInfo>(BuildInfoDto.schema);
const serverInfoSchema = typed<ServerInfoDto>(ServerInfoDto.schema);
const restartSchema = typed<RestartAcceptedDto>(RestartAcceptedDto.schema);
const schedulesSchema = typed<SchedulesEnvelope>(SchedulesEnvelopeDto.schema);
const harnessesSchema = typed<HarnessesEnvelope>(HarnessesEnvelopeDto.schema);
const usageSchema = typed<UsageResultDto>(UsageResultDto.schema);

// The DTO class doubles as its own instance type, so these need no shared plain type.
const createdSchema = typed<ScheduleCreatedDto>(ScheduleCreatedDto.schema);
const previewSchema = typed<SchedulePreviewDto>(SchedulePreviewDto.schema);
const logSchema = typed<ScheduleLogDto>(ScheduleLogDto.schema);
const okSchema = typed<OkDto>(OkDto.schema);
export interface RunVerifyEnvelope {
  ok: boolean;
  failures: Array<{ nodes: string[]; msg: string; hint: string }>;
}
const verifySchema = typed<RunVerifyEnvelope>(RunVerifyEnvelopeDto.schema);

const DOCUMENT_SCHEMAS: Readonly<Record<DocumentKind, z.ZodType<LoadedEnvelope>>> = {
  profiles: profilesEnvelopeSchema,
  memory: memoryEnvelopeSchema,
  suggestions: suggestionsEnvelopeSchema,
};

const UNAUTHORIZED = 401;

/**
 * Typed fetch wrapper. The token is read on every call, so a gate-supplied token is picked up by
 * the very next request. Every response body is parsed with the zod schema of the shared DTO that
 * the server answers with; a body that does not match resolves to `invalid`, never to bad data.
 * Maps every outcome onto ApiResult, so callers never need try/catch.
 */
/** A GET that takes longer than this fails as a network error. */
export const GET_TIMEOUT_MS = 30_000;

export class ApiClient {
  constructor(private readonly status: StatusStore = connection) {}

  getActive(etag: string | null): Promise<ApiResult<ActiveEnvelope>> {
    return this.request("GET", `${API_BASE}/active`, activeSchema, { etag, quiet: true });
  }

  getBuild(): Promise<ApiResult<BuildInfo>> {
    return this.request("GET", `${API_BASE}/build`, buildSchema, { quiet: true });
  }

  getServerInfo(): Promise<ApiResult<ServerInfoDto>> {
    return this.request("GET", `${API_BASE}/server-info`, serverInfoSchema, { quiet: true });
  }

  requestRestart(): Promise<ApiResult<RestartAcceptedDto>> {
    return this.request("POST", `${API_BASE}/build/restart`, restartSchema);
  }

  getRuns(etag: string | null, bypassCache = false) {
    const suffix = bypassCache ? "?cache=skip" : "";
    return this.request("GET", `${API_BASE}/runs${suffix}`, runsSchema, { etag });
  }

  getRun(id: string, etag: string | null, bypassCache = false) {
    const suffix = bypassCache ? "?cache=skip" : "";
    return this.request("GET", `${API_BASE}/runs/${encodeURIComponent(id)}${suffix}`, runSchema, { etag });
  }

  stopRun(id: string): Promise<ApiResult<OkDto>> {
    return this.request("POST", `${API_BASE}/runs/${encodeURIComponent(id)}/stop`, okSchema);
  }

  resumeRun(id: string): Promise<ApiResult<OkDto>> {
    return this.request("POST", `${API_BASE}/runs/${encodeURIComponent(id)}/resume`, okSchema);
  }

  pauseRun(id: string): Promise<ApiResult<OkDto>> {
    return this.request("POST", `${API_BASE}/runs/${encodeURIComponent(id)}/pause`, okSchema);
  }

  /** `run set <id> max_parallel`: the run's own cap, 1-30 or -1 (unlimited, still bounded by the global cap). */
  setRunMaxParallel(id: string, value: number): Promise<ApiResult<OkDto>> {
    return this.request("POST", `${API_BASE}/runs/${encodeURIComponent(id)}/max-parallel`, okSchema, { body: { value } });
  }

  /** `run verify`: the failures that keep the run from finishing. */
  verifyRun(id: string): Promise<ApiResult<RunVerifyEnvelope>> {
    return this.request("GET", `${API_BASE}/runs/${encodeURIComponent(id)}/verify`, verifySchema);
  }

  /** Finish by hand. A reason is required by the server when verify fails. */
  finishRun(id: string, reason: string): Promise<ApiResult<OkDto>> {
    return this.request("POST", `${API_BASE}/runs/${encodeURIComponent(id)}/finish`, okSchema, { body: { reason } });
  }

  /** `node update ... done --force --reason`. */
  markNodeDone(runId: string, nodeId: string, reason: string): Promise<ApiResult<OkDto>> {
    return this.request("POST", `${API_BASE}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/done`, okSchema, { body: { reason } });
  }

  /** `node result --verdict full --summary`: a done node flagged for review, checked by a person. */
  markNodeReviewed(runId: string, nodeId: string, reason: string): Promise<ApiResult<OkDto>> {
    return this.request("POST", `${API_BASE}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/reviewed`, okSchema, { body: { reason } });
  }

  cancelNode(runId: string, nodeId: string): Promise<ApiResult<OkDto>> {
    return this.request("POST", `${API_BASE}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/cancel`, okSchema);
  }

  /** `node reap`: kill a finished-but-alive node's job tree, keep its result, set it done. */
  reapNode(runId: string, nodeId: string): Promise<ApiResult<OkDto>> {
    return this.request("POST", `${API_BASE}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/reap`, okSchema);
  }

  retryRun(id: string): Promise<ApiResult<OkDto>> {
    return this.request("POST", `${API_BASE}/runs/${encodeURIComponent(id)}/retry`, okSchema);
  }

  retryNode(runId: string, nodeId: string): Promise<ApiResult<OkDto>> {
    return this.request("POST", `${API_BASE}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/retry`, okSchema);
  }

  /** `node tell` from the user: herdr pane push, else the node's inbox. */
  tellNode(runId: string, nodeId: string, text: string): Promise<ApiResult<OkDto>> {
    return this.request("POST", `${API_BASE}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/tell`, okSchema, { body: { text } });
  }

  /** `node answer` from the user; without `ask`, the node's oldest open ask. */
  answerNode(runId: string, nodeId: string, text: string, ask?: string): Promise<ApiResult<OkDto>> {
    const body = ask === undefined ? { text } : { text, ask };
    return this.request("POST", `${API_BASE}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/answer`, okSchema, { body });
  }

  /** `run repoint`: the user picks one candidate pane as the coordinator. */
  repointRun(runId: string, socketPath: string, paneId: string): Promise<ApiResult<OkDto>> {
    return this.request("POST", `${API_BASE}/runs/${encodeURIComponent(runId)}/repoint`, okSchema, { body: { socket_path: socketPath, pane_id: paneId } });
  }

  getRunMessages(runId: string) {
    return this.request("GET", `${API_BASE}/runs/${encodeURIComponent(runId)}/messages`, runMessagesSchema, { quiet: true });
  }

  stopActive(id: string): Promise<ApiResult<OkDto>> {
    return this.request("POST", `${API_BASE}/active/${encodeURIComponent(id)}/stop`, okSchema);
  }

  getJobLog(jobId: string) {
    return this.request("GET", `${API_BASE}/jobs/${encodeURIComponent(jobId)}/log`, jobLogSchema, { quiet: true });
  }

  /** A 404 is the normal answer for every harness but claude, so it must not move the freshness dot. */
  getJobChat(jobId: string) {
    return this.request("GET", `${API_BASE}/jobs/${encodeURIComponent(jobId)}/chat`, jobChatSchema, { quiet: true });
  }

  getRunNode(runId: string, nodeId: string) {
    return this.request("GET", `${API_BASE}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}`, runNodeSchema, { quiet: true });
  }

  getNodeActivity(runId: string, nodeId: string) {
    return this.request("GET", `${API_BASE}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/activity`, nodeActivitySchema, { quiet: true });
  }

  getDocument(kind: DocumentKind, etag: string | null): Promise<ApiResult<LoadedEnvelope>> {
    return this.request("GET", `${API_BASE}/${kind}`, DOCUMENT_SCHEMAS[kind], { etag });
  }

  /** Limits a profile or harness to chat, orch runs or both; the server runs `dispatch.ts <kind> set-usage`. */
  setUsage(kind: "profile" | "harness", id: string, usage: UsageChoice): Promise<ApiResult<UsageResultDto>> {
    return this.request("PATCH", `${API_BASE}/${kind === "profile" ? "profiles" : "harnesses"}/${encodeURIComponent(id)}/usage`, usageSchema, { body: { usage } });
  }

  putDocument(kind: DocumentKind, body: unknown, ifMatch: string): Promise<ApiResult<z.infer<typeof putOkSchema>>> {
    return this.request("PUT", `${API_BASE}/${kind}`, putOkSchema, { ifMatch, body });
  }

  getSchedules(etag: string | null): Promise<ApiResult<SchedulesEnvelope>> {
    return this.request("GET", `${API_BASE}/schedules`, schedulesSchema, { etag });
  }

  createSchedule(input: ScheduleInput): Promise<ApiResult<ScheduleCreatedDto>> {
    return this.request("POST", `${API_BASE}/schedules`, createdSchema, { body: input });
  }

  editSchedule(id: string, edit: ScheduleEdit): Promise<ApiResult<OkDto>> {
    return this.request("PUT", `${API_BASE}/schedules/${encodeURIComponent(id)}`, okSchema, { body: edit });
  }

  previewSchedule(cron: string): Promise<ApiResult<SchedulePreviewDto>> {
    return this.request("GET", `${API_BASE}/schedules/preview?cron=${encodeURIComponent(cron)}`, previewSchema, {
      quiet: true,
    });
  }

  scheduleAction(id: string, action: "run" | "enable" | "disable" | "mute" | "unmute" | "remove"): Promise<ApiResult<OkDto>> {
    return this.request("POST", `${API_BASE}/schedules/${encodeURIComponent(id)}/${action}`, okSchema);
  }

  getScheduleRunLog(id: string, index: number): Promise<ApiResult<ScheduleLogDto>> {
    return this.request("GET", `${API_BASE}/schedules/${encodeURIComponent(id)}/runs/${index}/log`, logSchema, {
      quiet: true,
    });
  }

  /** `refresh` skips the server's short cache, for the Re-detect button. */
  getHarnesses(refresh = false): Promise<ApiResult<HarnessesEnvelope>> {
    return this.request("GET", `${API_BASE}/harnesses${refresh ? "?refresh=1" : ""}`, harnessesSchema, {
      quiet: true,
    });
  }

  profileSanity(profiles?: readonly string[]) {
    const body =
      profiles === undefined || profiles.length === 0
        ? undefined
        : profiles.length === 1
          ? { profile: profiles[0] }
          : { profiles };
    return this.request("POST", `${API_BASE}/profiles/sanity`, sanitySchema, { body });
  }

  scanSuggestions(): Promise<ApiResult<OkDto>> {
    return this.request("POST", `${API_BASE}/suggestions/scan`, okSchema);
  }

  applySuggestions(ids?: readonly string[], all?: boolean) {
    const body = all === true ? { all: true } : ids !== undefined && ids.length > 0 ? { ids } : undefined;
    return this.request("POST", `${API_BASE}/suggestions/apply`, suggestionApplySchema, { body });
  }

  dismissSuggestion(id: string): Promise<ApiResult<OkDto>> {
    return this.request("POST", `${API_BASE}/suggestions/${encodeURIComponent(id)}/dismiss`, okSchema);
  }

  private headersFor(method: Method, options: RequestOptions): Headers {
    const headers = new Headers();
    const token = getToken();
    if (token !== null) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    if (options.etag) {
      headers.set("If-None-Match", options.etag);
    }
    if (options.ifMatch !== undefined) {
      headers.set("If-Match", options.ifMatch);
    }
    if (method === "PUT") {
      headers.set("Content-Type", "application/json");
    }
    return headers;
  }

  async request<T>(
    method: Method,
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions = {},
  ): Promise<ApiResult<T>> {
    const headers = this.headersFor(method, options);
    const init: RequestInit = { method, headers, cache: "no-store" };
    if (method === "PUT" || method === "PATCH" || (method === "POST" && options.body !== undefined)) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(options.body);
    }
    const isGet = method === "GET";
    if (isGet) {
      // A request that never answers must end as an error the page can show, not a loader that never stops.
      init.signal = AbortSignal.timeout(GET_TIMEOUT_MS);
    }
    const watch = isGet && options.quiet !== true;
    let res: Response;
    try {
      res = await fetch(path, init);
    } catch (err) {
      if (err instanceof Error) {
        if (watch) {
          this.status.network();
        }
        return { kind: "network" };
      }
      throw err;
    }
    if (res.status === 304) {
      if (isGet) {
        this.status.ok();
      }
      return { kind: "unchanged" };
    }
    const parsed = await ApiClient.parseJson(res);
    if (res.status === UNAUTHORIZED) {
      this.status.requireAuth();
    }
    if (!res.ok || parsed === undefined) {
      const failure = errorSchema.safeParse(parsed);
      const body: ApiError | null = failure.success && typeof parsed === "object" ? (parsed as ApiError) : null;
      if (watch && res.status !== UNAUTHORIZED) {
        this.status.fail(body?.error ?? `HTTP ${res.status}`);
      }
      return { kind: "error", status: res.status, body };
    }
    const checked = schema.safeParse(parsed);
    if (!checked.success) {
      const message = `unexpected response from ${path}: ${checked.error.issues[0]?.message ?? "bad shape"}`;
      if (watch) {
        this.status.fail(message);
      }
      return { kind: "invalid", message };
    }
    if (isGet) {
      this.status.ok();
    }
    return { kind: "ok", body: checked.data, etag: res.headers.get("ETag") };
  }

  private static async parseJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch (err) {
      if (err instanceof Error) {
        return undefined;
      }
      throw err;
    }
  }
}

export const api = new ApiClient();
