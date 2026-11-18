import { z } from "zod";
import { API_BASE } from "../lib/constants";
import { api } from "./client";
import type { ApiResult } from "./result";

/** The chat's `/feedback` calls. The shapes are read here, not validated: the server owns them. */
const anyBody = z.any();

export const feedbackChatApi = {
  add: (text: string, chatId: string): Promise<ApiResult<{ item: { id: string } }>> =>
    api.request("POST", `${API_BASE}/feedback`, anyBody as z.ZodType<{ item: { id: string } }>, { body: { text, source: "chat", chat_id: chatId } }),
  list: (): Promise<ApiResult<{ items: { id: string; status: string; text: string }[] }>> =>
    api.request("GET", `${API_BASE}/feedback`, anyBody as z.ZodType<{ items: { id: string; status: string; text: string }[] }>, { quiet: true }),
  work: (): Promise<ApiResult<{ run_id: string | null; items: string[] }>> =>
    api.request("POST", `${API_BASE}/feedback/work`, anyBody as z.ZodType<{ run_id: string | null; items: string[] }>, { body: {} }),
};
