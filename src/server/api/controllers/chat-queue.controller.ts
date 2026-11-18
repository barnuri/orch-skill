import { Body, Controller, Delete, Get, Param, Patch, Post, Response as ResponseSchema } from "@barnuri/hono-decorators";

import {
  QueueEditDto, QueueItemEnvelopeDto, QueueItemParamsDto, QueueReorderDto, QueueSendNowResultDto, QueueSnapshotDto,
} from "../../../shared/dto/chat-queue";
import { ChatIdParamsDto, SendMessageDto } from "../../../shared/dto/chats";
import { ErrorDto } from "../../../shared/dto/common";
import { QueueError } from "../../chats/queue";
import { type ChatService, chatServiceFor } from "../../chats/service";
import { jsonResponse } from "../../http/responses";
import type { ServerContext } from "../../types/server-context";
import type { ApiContext } from "../pipeline";
import { failure, idOf } from "./projects.controller";
import { valid } from "./support";

function queueFailure(err: unknown): Response {
  return err instanceof QueueError ? jsonResponse(err.status, { error: err.message }) : failure(err);
}

function qidOf(c: ApiContext): string {
  return c.req.param("qid") as string;
}

@Controller({ path: "/api", tags: ["chats", "queue"] })
export class ChatQueueController {
  private readonly service: ChatService;

  constructor(ctx: ServerContext) {
    this.service = chatServiceFor(ctx);
  }

  @Get("/chats/{id}/queue", {
    summary: "Read a chat's message queue",
    description: "The running queued message (if any) first, then the waiting ones in order. `paused` is true when the queue waits for a person: after a failed or stopped reply, or after a dashboard restart. Changes are also pushed as `queue` events on GET /api/chats/{id}/events.",
  })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(QueueSnapshotDto.schema, { description: "The queue." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such chat." })
  read(c: ApiContext): Response {
    try {
      this.service.chat(idOf(c));
      return jsonResponse(200, this.service.queue.snapshot(idOf(c)));
    } catch (err) {
      return queueFailure(err);
    }
  }

  @Post("/chats/{id}/queue", {
    summary: "Queue a message",
    description: "Same body as sending a message. The message waits at the end of the queue and runs when the earlier ones are done. At most 20 messages wait per chat and the text is at most 50 KB. Answers 409 when the queue is full or the chat is archived, 413 for text over 50 KB, 400 for an empty message or unknown attachments.",
  })
  @Param(ChatIdParamsDto.schema)
  @Body(SendMessageDto.schema)
  @ResponseSchema(QueueItemEnvelopeDto.schema, { status: 201, description: "Queued." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Invalid message." })
  @ResponseSchema(ErrorDto.schema, { status: 409, description: "The queue is full, or the chat is archived." })
  @ResponseSchema(ErrorDto.schema, { status: 413, description: "Text over 50 KB." })
  enqueue(c: ApiContext): Response {
    try {
      const id = idOf(c);
      this.service.chat(id);
      const item = this.service.queue.enqueue(id, valid(c, "json"));
      if (!this.service.queue.isPaused(id)) {
        this.service.queue.advance(id);
      }
      return jsonResponse(201, { item });
    } catch (err) {
      return queueFailure(err);
    }
  }

  @Post("/chats/{id}/queue/reorder", {
    summary: "Reorder the queued messages",
    description: "`ids` come first in that order; queued messages not listed keep their order after them. Answers 409 `Already started` when one of the ids is no longer queued.",
  })
  @Param(ChatIdParamsDto.schema)
  @Body(QueueReorderDto.schema)
  @ResponseSchema(QueueSnapshotDto.schema, { description: "The queue after the change." })
  @ResponseSchema(ErrorDto.schema, { status: 409, description: "A listed message already started." })
  reorder(c: ApiContext): Response {
    try {
      const id = idOf(c);
      this.service.chat(id);
      return jsonResponse(200, this.service.queue.reorder(id, valid<{ ids: string[] }>(c, "json").ids));
    } catch (err) {
      return queueFailure(err);
    }
  }

  @Post("/chats/{id}/queue/resume", {
    summary: "Resume a paused queue",
    description: "Lets the queue start the next message by itself again, and starts it now when no reply is running.",
  })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(QueueSnapshotDto.schema, { description: "The queue after the change." })
  resume(c: ApiContext): Response {
    try {
      const id = idOf(c);
      this.service.chat(id);
      return jsonResponse(200, this.service.queue.resume(id));
    } catch (err) {
      return queueFailure(err);
    }
  }

  @Patch("/chats/{id}/queue/{qid}", {
    summary: "Edit a queued message",
    description: "Changes the text or the attachments. Only while the message is queued: answers 409 `Already started` once it began, so a message the agent already received is never rewritten.",
  })
  @Param(QueueItemParamsDto.schema)
  @Body(QueueEditDto.schema)
  @ResponseSchema(QueueItemEnvelopeDto.schema, { description: "The message after the change." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such queued message." })
  @ResponseSchema(ErrorDto.schema, { status: 409, description: "Already started." })
  edit(c: ApiContext): Response {
    try {
      const id = idOf(c);
      this.service.chat(id);
      return jsonResponse(200, { item: this.service.queue.edit(id, qidOf(c), valid(c, "json")) });
    } catch (err) {
      return queueFailure(err);
    }
  }

  @Delete("/chats/{id}/queue/{qid}", {
    summary: "Cancel a queued message",
    description: "Removes a message that has not started. The row is kept as `cancelled`. Answers 409 `Already started` once it began.",
  })
  @Param(QueueItemParamsDto.schema)
  @ResponseSchema(QueueItemEnvelopeDto.schema, { description: "The cancelled message." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such queued message." })
  @ResponseSchema(ErrorDto.schema, { status: 409, description: "Already started." })
  cancel(c: ApiContext): Response {
    try {
      const id = idOf(c);
      this.service.chat(id);
      return jsonResponse(200, { item: this.service.queue.cancel(id, qidOf(c)) });
    } catch (err) {
      return queueFailure(err);
    }
  }

  @Post("/chats/{id}/queue/{qid}/send-now", {
    summary: "Run a queued message now",
    description: "Stops the running reply (its partial text is kept, it ends as `stopped`), then runs this message next, even when the queue was paused. The other queued messages keep their order behind it. With no reply running it just starts. Answers 409 `Already started` when the message is no longer queued.",
  })
  @Param(QueueItemParamsDto.schema)
  @ResponseSchema(QueueSendNowResultDto.schema, { description: "Done." })
  @ResponseSchema(ErrorDto.schema, { status: 409, description: "Already started." })
  sendNow(c: ApiContext): Promise<Response> {
    return Promise.resolve()
      .then(async () => {
        const id = idOf(c);
        this.service.chat(id);
        const { interrupted } = await this.service.queue.sendNow(id, qidOf(c));
        return jsonResponse(200, { ok: true, interrupted });
      })
      .catch(queueFailure);
  }
}
