import { Controller, Get, Param, Patch, Post, Query, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { ErrorDto } from "../../../shared/dto/common";
import {
  FeedbackIdParamsDto, FeedbackItemEnvelopeDto, FeedbackListDto, FeedbackListQueryDto,
  FeedbackWorkResultDto,
} from "../../../shared/dto/feedback";
import type { RouteHandler } from "../../http/route";
import {
  createFeedbackHandler,
  listFeedbackHandler,
  updateFeedbackHandler,
  workFeedbackHandler,
} from "../../routes/feedback-routes";
import type { ServerContext } from "../../types/server-context";
import type { ApiContext } from "../pipeline";
import { call } from "./support";

@Controller({ path: "/api", tags: ["feedback"] })
export class FeedbackController {
  private readonly list_: RouteHandler;
  private readonly create_: RouteHandler;
  private readonly update_: RouteHandler;
  private readonly work_: RouteHandler;

  constructor(ctx: ServerContext) {
    this.list_ = listFeedbackHandler(ctx);
    this.create_ = createFeedbackHandler(ctx);
    this.update_ = updateFeedbackHandler(ctx);
    this.work_ = workFeedbackHandler(ctx);
  }

  @Get("/feedback", {
    summary: "List feedback",
    description: "Feedback items, oldest first. `?status=new|queued|working|done|wontfix` filters them.",
  })
  @Query(FeedbackListQueryDto.schema)
  @ResponseSchema(FeedbackListDto.schema, { description: "The items." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Unknown status." })
  list(c: ApiContext): Promise<Response> {
    return call(this.list_, c);
  }

  @Post("/feedback", {
    summary: "Add feedback",
    description: "Adds one item with status `new`. Body: `text` (required), `kind` (bug|idea|ux|other), `source` (chat|cli|ui, default ui), optional `chat_id`, `run_id`, `node_id`. When an open item already exists for the same run and node (or, with no run and no node, the same normalized text), the text is added to it as a note and that item is returned with 200.",
  })
  @ResponseSchema(FeedbackItemEnvelopeDto.schema, { status: 201, description: "The new item." })
  @ResponseSchema(FeedbackItemEnvelopeDto.schema, { status: 200, description: "The existing open item, with the text added as a note." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Invalid body." })
  create(c: ApiContext): Promise<Response> {
    return call(this.create_, c);
  }

  @Patch("/feedback/{id}", {
    summary: "Change feedback",
    description: "Sets `status`, `result` or `work_run` on one item.",
  })
  @Param(FeedbackIdParamsDto.schema)
  @ResponseSchema(FeedbackItemEnvelopeDto.schema, { description: "The updated item." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Invalid body." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such feedback item." })
  update(c: ApiContext): Promise<Response> {
    return call(this.update_, c);
  }

  @Post("/feedback/work", {
    summary: "Work on feedback",
    description: "Puts the new items (or `ids`) into one run titled \"feedback batch\": one node per item and a validation node. Items go queued, then working.",
  })
  @ResponseSchema(FeedbackWorkResultDto.schema, { description: "The run id and the item ids." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Bad ids, or an item is not new." })
  work(c: ApiContext): Promise<Response> {
    return call(this.work_, c);
  }
}
