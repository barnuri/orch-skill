import type { z } from "zod";
import { ChatItemCreatedDto, ChatItemLogDto, ChatItemsDto } from "../../shared/dto/chat-automation";
import { OkDto } from "../../shared/dto/common";
import type { ChatLoop, ChatMonitor, LogEntry, LoopInput, MonitorInput, ScheduleCreate } from "../../shared/types/chat-automation";
import type { Schedule } from "../../shared/types/schedule";
import { API_BASE } from "../lib/constants";
import { api } from "./client";
import type { ApiResult } from "./result";

function typed<T>(schema: unknown): z.ZodType<T> {
  return schema as z.ZodType<T>;
}

const schedules = typed<{ items: Schedule[] }>(ChatItemsDto.schema);
const loops = typed<{ items: ChatLoop[] }>(ChatItemsDto.schema);
const monitors = typed<{ items: ChatMonitor[] }>(ChatItemsDto.schema);
const created = typed<{ id: string }>(ChatItemCreatedDto.schema);
const log = typed<{ entries: LogEntry[] }>(ChatItemLogDto.schema);
const ok = typed<{ ok: boolean }>(OkDto.schema);

const q = encodeURIComponent;
const base = (chat: string, kind: "schedules" | "loops" | "monitors"): string => `${API_BASE}/chats/${q(chat)}/${kind}`;

export type ScheduleDraftBody = ScheduleCreate;
export type LoopDraftBody = LoopInput;
export type MonitorDraftBody = MonitorInput;
export type SchedulePatch = Partial<Pick<ScheduleCreate, "name" | "prompt" | "cron" | "timezone" | "mode">> & { enabled?: boolean };

export const automationApi = {
  schedules: (chat: string): Promise<ApiResult<{ items: Schedule[] }>> => api.request("GET", base(chat, "schedules"), schedules, { quiet: true }),
  createSchedule: (chat: string, body: ScheduleCreate): Promise<ApiResult<{ id: string }>> => api.request("POST", base(chat, "schedules"), created, { body }),
  editSchedule: (chat: string, id: string, body: SchedulePatch): Promise<ApiResult<{ ok: boolean }>> => api.request("PATCH", `${base(chat, "schedules")}/${q(id)}`, ok, { body }),
  deleteSchedule: (chat: string, id: string): Promise<ApiResult<{ ok: boolean }>> => api.request("DELETE", `${base(chat, "schedules")}/${q(id)}`, ok),
  scheduleAction: (chat: string, id: string, action: "run-now" | "pause" | "resume"): Promise<ApiResult<{ ok: boolean }>> => api.request("POST", `${base(chat, "schedules")}/${q(id)}/${action}`, ok),
  scheduleLog: (chat: string, id: string): Promise<ApiResult<{ entries: LogEntry[] }>> => api.request("GET", `${base(chat, "schedules")}/${q(id)}/log`, log, { quiet: true }),

  loops: (chat: string): Promise<ApiResult<{ items: ChatLoop[] }>> => api.request("GET", base(chat, "loops"), loops, { quiet: true }),
  createLoop: (chat: string, body: LoopInput): Promise<ApiResult<{ id: string }>> => api.request("POST", base(chat, "loops"), created, { body }),
  loopAction: (chat: string, id: string, action: "stop" | "resume"): Promise<ApiResult<{ ok: boolean }>> => api.request("POST", `${base(chat, "loops")}/${q(id)}/${action}`, ok),
  loopLog: (chat: string, id: string): Promise<ApiResult<{ entries: LogEntry[] }>> => api.request("GET", `${base(chat, "loops")}/${q(id)}/log`, log, { quiet: true }),

  monitors: (chat: string): Promise<ApiResult<{ items: ChatMonitor[] }>> => api.request("GET", base(chat, "monitors"), monitors, { quiet: true }),
  createMonitor: (chat: string, body: MonitorInput): Promise<ApiResult<{ id: string }>> => api.request("POST", base(chat, "monitors"), created, { body }),
  monitorAction: (chat: string, id: string, action: "stop" | "pause" | "resume" | "run-now"): Promise<ApiResult<{ ok: boolean }>> => api.request("POST", `${base(chat, "monitors")}/${q(id)}/${action}`, ok),
  monitorLog: (chat: string, id: string): Promise<ApiResult<{ entries: LogEntry[] }>> => api.request("GET", `${base(chat, "monitors")}/${q(id)}/log`, log, { quiet: true }),

  markRead: (chat: string): Promise<ApiResult<{ ok: boolean }>> => api.request("POST", `${API_BASE}/chats/${q(chat)}/read`, ok, { quiet: true }),
};
