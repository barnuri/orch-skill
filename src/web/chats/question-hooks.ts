import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { questionsApi } from "../api/chat-questions";
import { type ChatPart } from "../../shared/chat-parts";
import type { QuestionPart } from "../../shared/chat-question";
import type { Message } from "../lib/chat-types";
import { partsOf } from "./chat-group";

/** Ids of the chats that wait for an answer. The key starts with "chats", so refreshChats() refreshes it too. */
export function useWaitingChats(): Set<string> {
  const { data } = useQuery({
    queryKey: ["chats", "waiting"],
    queryFn: async () => {
      const res = await questionsApi.waiting();
      return res.kind === "ok" ? res.body.chat_ids : [];
    },
    refetchInterval: 5000,
  });
  return new Set(data ?? []);
}

/** "(2) " in the browser tab title while chats wait for an answer. */
export function useWaitingTitle(): void {
  const waiting = useWaitingChats().size;
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, "");
    document.title = waiting > 0 ? `(${waiting}) ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [waiting]);
}

export const questionOf = (m: Message): QuestionPart | null => {
  const part = (partsOf(m) ?? []).find((p: ChatPart): p is QuestionPart => p.type === "question");
  return part ?? null;
};

/** The newest question that still waits and has no user message after it. */
export function pendingQuestion(rows: readonly Message[]): { message: Message; part: QuestionPart } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i] as Message;
    if (m.role === "user") {
      return null;
    }
    const part = m.role === "tool" ? questionOf(m) : null;
    if (part !== null && part.state === "pending") {
      return { message: m, part };
    }
  }
  return null;
}

/** Sends the answer and refreshes the chat lists. Resolves to an error text, or null. */
export function useAnswerQuestion(chatId: string): (qid: string, answers: string[][] | null) => Promise<string | null> {
  const client = useQueryClient();
  return async (qid, answers) => {
    const res = await questionsApi.answer(chatId, qid, answers);
    void client.invalidateQueries({ queryKey: ["chats"] });
    if (res.kind === "ok") {
      return null;
    }
    if (res.kind === "error") {
      return res.body?.error ?? `could not send the answer (${res.status})`;
    }
    return res.kind === "network" ? "could not reach the dashboard" : "could not send the answer";
  };
}
