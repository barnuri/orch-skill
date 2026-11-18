import { z } from "zod";
import type { FeedbackItem, FeedbackKind, FeedbackStatus } from "../../shared/types/feedback";
import { API_BASE } from "../lib/constants";
import { api } from "./client";
import type { ApiResult } from "./result";

const itemSchema = z.looseObject({ id: z.string(), text: z.string(), status: z.string(), kind: z.string(), source: z.string() });
const listSchema = z.object({ items: z.array(itemSchema) }).transform((body) => ({ items: body.items as unknown as FeedbackItem[] }));
const itemEnvelopeSchema = z.object({ item: itemSchema }).transform((body) => ({ item: body.item as unknown as FeedbackItem }));
const workSchema = z.object({ run_id: z.string().nullable(), items: z.array(z.string()) });

export interface FeedbackWork {
  run_id: string | null;
  items: string[];
}

export const feedbackApi = {
  list: (): Promise<ApiResult<{ items: FeedbackItem[] }>> => api.request("GET", `${API_BASE}/feedback`, listSchema, { quiet: true }),
  create: (text: string, kind: FeedbackKind): Promise<ApiResult<{ item: FeedbackItem }>> =>
    api.request("POST", `${API_BASE}/feedback`, itemEnvelopeSchema, { body: { text, kind, source: "ui" } }),
  setStatus: (id: string, status: FeedbackStatus): Promise<ApiResult<{ item: FeedbackItem }>> =>
    api.request("PATCH", `${API_BASE}/feedback/${encodeURIComponent(id)}`, itemEnvelopeSchema, { body: { status } }),
  work: (ids?: readonly string[]): Promise<ApiResult<FeedbackWork>> =>
    api.request("POST", `${API_BASE}/feedback/work`, workSchema, { body: ids !== undefined && ids.length > 0 ? { ids } : {} }),
};
