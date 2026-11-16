import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

@ZodObject({ description: "A chat and one of its agent questions." })
export class QuestionParamsDto extends ZodDto {
  @ZodField(z.string().min(1).max(100), { description: "Chat id, `chat-…`." })
  id!: string;

  @ZodField(z.string().min(1).max(200), { description: "Question id: the harness tool call id of the `question` part." })
  qid!: string;
}

@ZodObject({ description: "Answer to a question, or a dismissal. Send `answers` or `dismiss: true`, not both." })
export class QuestionAnswerDto extends ZodDto {
  @ZodField(z.array(z.array(z.string().max(5000)).max(50)).max(20).optional(), { description: "One list per question: the chosen option labels, or typed text when the question allows custom answers." })
  answers?: string[][];

  @ZodField(z.string().max(5000).optional(), { description: "Typed answer for a call with a single question; added to its `answers`." })
  custom?: string;

  @ZodField(z.boolean().optional(), { description: "True to skip the question. The agent is told it was skipped." })
  dismiss?: boolean;
}

@ZodObject({ description: "The answer was delivered: the reply it starts is running." })
export class QuestionAnswerResultDto extends ZodDto {
  @ZodField(z.boolean(), { description: "Always true." })
  ok!: boolean;

  @ZodField(z.string(), { description: "The user message that carries the answer." })
  user_message_id!: string;

  @ZodField(z.string(), { description: "The reply that follows it." })
  assistant_message_id!: string;
}

@ZodObject({ description: "Chats that wait for an answer to a question." })
export class WaitingChatsDto extends ZodDto {
  @ZodField(z.array(z.string()), { description: "Chat ids." })
  chat_ids!: string[];
}
