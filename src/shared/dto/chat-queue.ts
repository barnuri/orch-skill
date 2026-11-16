import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

/** At most this many messages wait in one chat's queue. */
export const QUEUE_MAX_ITEMS = 20;
/** Longest queued text, in bytes (UTF-8). */
export const QUEUE_MAX_TEXT_BYTES = 50 * 1024;

const STATE = z.enum(["queued", "running", "sent", "cancelled"]);

@ZodObject({ description: "A chat and one of its queued messages." })
export class QueueItemParamsDto extends ZodDto {
  @ZodField(z.string().min(1).max(100), { description: "Chat id, `chat-…`." })
  id!: string;

  @ZodField(z.string().min(1).max(100), { description: "Queue item id, `que-…`." })
  qid!: string;
}

@ZodObject({ description: "One message in a chat's queue." })
export class QueueItemDto extends ZodDto {
  @ZodField(z.string(), { description: "Id, `que-…`." })
  id!: string;

  @ZodField(z.string(), { description: "The chat." })
  chat_id!: string;

  @ZodField(z.string(), { description: "The message text. May be empty when attachments are given." })
  text!: string;

  @ZodField(z.array(z.string()), { description: "Ids of the uploaded files that go with the message." })
  attachment_ids!: string[];

  @ZodField(z.number().int(), { description: "1-based place among the waiting messages. 0 for the one that is running." })
  position!: number;

  @ZodField(STATE, { description: "queued waits, running is the turn in progress, sent and cancelled are over (they are not listed)." })
  state!: "queued" | "running" | "sent" | "cancelled";

  @ZodField(z.string(), { description: "ISO 8601 UTC." })
  created_at!: string;

  @ZodField(z.string().nullable(), { description: "When a person last edited it. Null when never." })
  edited_at!: string | null;

  @ZodField(z.string().nullable(), { description: "The user message it became once it started." })
  message_id!: string | null;
}

@ZodObject({ description: "The queue of a chat: the running message first, then the waiting ones in order." })
export class QueueSnapshotDto extends ZodDto {
  @ZodField(z.string(), { description: "The chat." })
  chat_id!: string;

  @ZodField(z.array(QueueItemDto.schema), { description: "The running item (if any), then the queued ones." })
  items!: QueueItemDto[];

  @ZodField(z.boolean(), { description: "True when the queue does not start the next message by itself: after a failed or stopped reply, or a restart. POST /queue/resume starts it." })
  paused!: boolean;

  @ZodField(z.string().nullable(), { description: "Why it is paused." })
  reason!: string | null;
}

@ZodObject({ description: "Changes to a queued message. Allowed only while it is queued." })
export class QueueEditDto extends ZodDto {
  @ZodField(z.string().max(100000).optional(), { description: "New text." })
  content?: string;

  @ZodField(z.array(z.string().max(100)).max(20).optional(), { description: "New list of attachment ids (replaces the old list)." })
  attachment_ids?: string[];
}

@ZodObject({ description: "The new order of the queued messages." })
export class QueueReorderDto extends ZodDto {
  @ZodField(z.array(z.string().max(100)).max(QUEUE_MAX_ITEMS), { description: "Queue item ids in the wanted order. Queued messages left out keep their relative order after these." })
  ids!: string[];
}

@ZodObject({ description: "A queue item after a change." })
export class QueueItemEnvelopeDto extends ZodDto {
  @ZodField(QueueItemDto.schema, { description: "The item." })
  item!: QueueItemDto;
}

@ZodObject({ description: "Result of send-now." })
export class QueueSendNowResultDto extends ZodDto {
  @ZodField(z.boolean(), { description: "Always true." })
  ok!: boolean;

  @ZodField(z.boolean(), { description: "True when a running reply was stopped to make room." })
  interrupted!: boolean;
}
