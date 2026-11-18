import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

const STATUS = z.enum(["new", "queued", "working", "done", "wontfix"]);
const KIND = z.enum(["bug", "idea", "ux", "other"]);
const SOURCE = z.enum(["chat", "cli", "ui"]);

@ZodObject({ description: "One feedback item." })
export class FeedbackItemDto extends ZodDto {
  @ZodField(z.string(), { description: "Id, `fb-yyyymmdd-n`." })
  id!: string;

  @ZodField(z.string(), { description: "What the user wrote." })
  text!: string;

  @ZodField(STATUS, { description: "Lifecycle: new, queued, working, done, wontfix." })
  status!: "new" | "queued" | "working" | "done" | "wontfix";

  @ZodField(KIND, { description: "What kind of feedback." })
  kind!: "bug" | "idea" | "ux" | "other";

  @ZodField(SOURCE, { description: "Where it was filed." })
  source!: "chat" | "cli" | "ui";

  @ZodField(z.string().optional(), { description: "Chat it came from." })
  chat_id?: string;

  @ZodField(z.string().optional(), { description: "Run it is about." })
  run_id?: string;

  @ZodField(z.string().optional(), { description: "Node it is about." })
  node_id?: string;

  @ZodField(z.string().optional(), { description: "Outcome note, set when the item is done or wontfix." })
  result?: string;

  @ZodField(z.string().optional(), { description: "The run that works on it." })
  work_run?: string;

  @ZodField(z.string().optional(), { description: "Creation time, ISO 8601 UTC." })
  created?: string;

  @ZodField(z.string().optional(), { description: "Last change, ISO 8601 UTC." })
  updated?: string;
}

@ZodObject({ description: "The feedback list." })
export class FeedbackListDto extends ZodDto {
  @ZodField([FeedbackItemDto], { description: "Items, oldest first." })
  items!: FeedbackItemDto[];
}

@ZodObject({ description: "One feedback item, wrapped." })
export class FeedbackItemEnvelopeDto extends ZodDto {
  @ZodField(FeedbackItemDto, { description: "The item." })
  item!: FeedbackItemDto;
}

@ZodObject({ description: "Query of GET /api/feedback." })
export class FeedbackListQueryDto extends ZodDto {
  @ZodField(STATUS.optional(), { description: "Keep only items with this status." })
  status?: "new" | "queued" | "working" | "done" | "wontfix";
}

@ZodObject({ description: "Body of POST /api/feedback." })
export class FeedbackCreateDto extends ZodDto {
  @ZodField(z.string().max(8000), { description: "The feedback text, at most 8000 characters." })
  text!: string;

  @ZodField(KIND.optional(), { description: "Default `other`." })
  kind?: "bug" | "idea" | "ux" | "other";

  @ZodField(SOURCE.optional(), { description: "Default `ui`." })
  source?: "chat" | "cli" | "ui";

  @ZodField(z.string().optional(), { description: "Chat id." })
  chat_id?: string;

  @ZodField(z.string().optional(), { description: "Run id." })
  run_id?: string;

  @ZodField(z.string().optional(), { description: "Node id." })
  node_id?: string;
}

@ZodObject({ description: "Path parameter of the feedback item routes." })
export class FeedbackIdParamsDto extends ZodDto {
  @ZodField(z.string(), { description: "Feedback id, `fb-yyyymmdd-n`." })
  id!: string;
}

@ZodObject({ description: "Body of PATCH /api/feedback/{id}. Give at least one field." })
export class FeedbackPatchDto extends ZodDto {
  @ZodField(STATUS.optional(), { description: "New status." })
  status?: "new" | "queued" | "working" | "done" | "wontfix";

  @ZodField(z.string().optional(), { description: "Outcome note." })
  result?: string;

  @ZodField(z.string().optional(), { description: "Id of the run that works on it." })
  work_run?: string;
}

@ZodObject({ description: "Body of POST /api/feedback/work. Omit `ids` to take every new item." })
export class FeedbackWorkDto extends ZodDto {
  @ZodField(z.array(z.string()).min(1).optional(), { description: "Feedback ids to work on." })
  ids?: string[];
}

@ZodObject({ description: "The `dispatch.ts feedback work --json` output." })
export class FeedbackWorkResultDto extends ZodDto {
  @ZodField(z.string().nullable(), { description: "Id of the run created for the batch, null when there was nothing to work on." })
  run_id!: string | null;

  @ZodField(z.array(z.string()), { description: "Ids of the items put into the run." })
  items!: string[];
}
