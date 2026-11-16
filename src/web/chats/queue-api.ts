import type { z } from "zod";
import { QueueItemEnvelopeDto, QueueSendNowResultDto, QueueSnapshotDto } from "../../shared/dto/chat-queue";
import { api } from "../api/client";
import type { ApiResult } from "../api/result";
import { API_BASE } from "../lib/constants";
import type { QueueItem, QueueSnapshot } from "./queue-logic";

function typed<T>(schema: unknown): z.ZodType<T> {
  return schema as z.ZodType<T>;
}

const snapshotSchema = typed<QueueSnapshot>(QueueSnapshotDto.schema);
const itemSchema = typed<{ item: QueueItem }>(QueueItemEnvelopeDto.schema);
const sendNowSchema = typed<{ ok: boolean; interrupted: boolean }>(QueueSendNowResultDto.schema);

const q = encodeURIComponent;
const base = (chatId: string): string => `${API_BASE}/chats/${q(chatId)}/queue`;

export const queueApi = {
  read: (chatId: string): Promise<ApiResult<QueueSnapshot>> => api.request("GET", base(chatId), snapshotSchema, { quiet: true }),
  edit: (chatId: string, qid: string, body: { content?: string; attachment_ids?: string[] }) => api.request("PATCH", `${base(chatId)}/${q(qid)}`, itemSchema, { body }),
  cancel: (chatId: string, qid: string) => api.request("DELETE", `${base(chatId)}/${q(qid)}`, itemSchema),
  sendNow: (chatId: string, qid: string) => api.request("POST", `${base(chatId)}/${q(qid)}/send-now`, sendNowSchema),
  reorder: (chatId: string, ids: readonly string[]) => api.request("POST", `${base(chatId)}/reorder`, snapshotSchema, { body: { ids } }),
  resume: (chatId: string) => api.request("POST", `${base(chatId)}/resume`, snapshotSchema),
};
