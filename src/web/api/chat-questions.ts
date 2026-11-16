import type { z } from "zod";
import { QuestionAnswerResultDto, WaitingChatsDto } from "../../shared/dto/chat-question";
import { API_BASE } from "../lib/constants";
import { api } from "./client";
import type { ApiResult } from "./result";

const resultSchema = QuestionAnswerResultDto.schema as unknown as z.ZodType<{ ok: boolean; user_message_id: string; assistant_message_id: string }>;
const waitingSchema = WaitingChatsDto.schema as unknown as z.ZodType<{ chat_ids: string[] }>;

export const questionsApi = {
  /** `answers` null skips the question. */
  answer: (chatId: string, qid: string, answers: string[][] | null): Promise<ApiResult<{ ok: boolean; user_message_id: string; assistant_message_id: string }>> =>
    api.request("POST", `${API_BASE}/chats/${encodeURIComponent(chatId)}/questions/${encodeURIComponent(qid)}/answer`, resultSchema, { body: answers === null ? { dismiss: true } : { answers } }),
  waiting: (): Promise<ApiResult<{ chat_ids: string[] }>> => api.request("GET", `${API_BASE}/chats/questions/waiting`, waitingSchema, { quiet: true }),
};
