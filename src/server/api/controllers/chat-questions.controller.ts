import { Body, Controller, Get, Param, Post, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { ErrorDto } from "../../../shared/dto/common";
import { QuestionAnswerDto, QuestionAnswerResultDto, QuestionParamsDto, WaitingChatsDto } from "../../../shared/dto/chat-question";
import { type ChatService, chatServiceFor } from "../../chats/service";
import { jsonResponse } from "../../http/responses";
import type { ServerContext } from "../../types/server-context";
import type { ApiContext } from "../pipeline";
import { failure } from "./projects.controller";
import { valid } from "./support";

@Controller({ path: "/api", tags: ["chats"] })
export class ChatQuestionsController {
  private readonly service: ChatService;

  constructor(ctx: ServerContext) {
    this.service = chatServiceFor(ctx);
  }

  @Get("/chats/questions/waiting", {
    summary: "Chats waiting for an answer",
    description: "Ids of the chats whose agent asked a question that is still pending. The chat list shows an amber dot for them.",
  })
  @ResponseSchema(WaitingChatsDto.schema, { description: "The chat ids." })
  waiting(): Response {
    return jsonResponse(200, { chat_ids: this.service.chatsWaitingForAnswer() });
  }

  @Post("/chats/{id}/questions/{qid}/answer", {
    summary: "Answer or skip the agent's question",
    description: "The agent's `question` tool ends its run and waits (no harness has a live channel for the reply). This settles the question part (`answered` or `dismissed`) and starts the next reply with the answer as a user message that begins `[Answer to your question]`. 409 when the question is already settled or a reply is running; 400 when an answer is not an option and the question does not allow custom answers.",
  })
  @Param(QuestionParamsDto.schema)
  @Body(QuestionAnswerDto.schema)
  @ResponseSchema(QuestionAnswerResultDto.schema, { description: "Delivered." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Invalid answer." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such chat or question." })
  @ResponseSchema(ErrorDto.schema, { status: 409, description: "Already settled, or a reply is running." })
  answer(c: ApiContext): Promise<Response> {
    return Promise.resolve().then(() => {
      const { id, qid } = valid<{ id: string; qid: string }>(c, "param");
      const body = valid<{ answers?: string[][]; custom?: string; dismiss?: boolean }>(c, "json");
      if (body.dismiss === true) {
        if (body.answers !== undefined || body.custom !== undefined) {
          return jsonResponse(400, { error: "dismiss: do not send answers with it" });
        }
        const r = this.service.answerQuestion(id, qid, null);
        return jsonResponse(200, { ok: true, user_message_id: r.user_message_id, assistant_message_id: r.assistant_message_id });
      }
      let answers = body.answers;
      if (body.custom !== undefined) {
        if (answers === undefined) {
          answers = [[body.custom]];
        } else if (answers.length === 1) {
          answers = [[...(answers[0] ?? []), body.custom]];
        } else {
          return jsonResponse(400, { error: "custom: only for a call with one question; put the text in answers" });
        }
      }
      if (answers === undefined) {
        return jsonResponse(400, { error: "answers: send answers or dismiss" });
      }
      const r = this.service.answerQuestion(id, qid, answers);
      return jsonResponse(200, { ok: true, user_message_id: r.user_message_id, assistant_message_id: r.assistant_message_id });
    }).catch(failure);
  }
}
