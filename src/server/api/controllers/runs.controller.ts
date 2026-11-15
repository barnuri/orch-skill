import { Controller, Get, Param, Post, Response as ResponseSchema } from "@barnuri/hono-decorators";

import type { RouteHandler } from "../../http/route";
import {
  listRunsHandler,
  readJobChatHandler,
  readJobLogHandler,
  readRunHandler,
  retryNodeHandler,
  retryRunHandler,
  stopRunHandler,
} from "../../routes/runs-routes";
import type { ServerContext } from "../../types/server-context";
import { ErrorDto, OkDto } from "../dto/common";
import { ChatEnvelopeDto, JobIdParamsDto, JobLogEnvelopeDto, RunEnvelopeDto, RunIdParamsDto, RunNodeParamsDto, RunsEnvelopeDto } from "../dto/runs";
import type { ApiContext } from "../pipeline";
import { call } from "./support";

@Controller({ path: "/api", tags: ["runs"] })
export class RunsController {
  private readonly list: RouteHandler;
  private readonly read: RouteHandler;
  private readonly retry: RouteHandler;
  private readonly stop: RouteHandler;
  private readonly retryNode: RouteHandler;
  private readonly jobLog: RouteHandler;
  private readonly jobChat: RouteHandler;

  constructor(ctx: ServerContext) {
    this.list = listRunsHandler(ctx);
    this.read = readRunHandler(ctx);
    this.retry = retryRunHandler(ctx);
    this.stop = stopRunHandler(ctx);
    this.retryNode = retryNodeHandler(ctx);
    this.jobLog = readJobLogHandler(ctx);
    this.jobChat = readJobChatHandler(ctx);
  }

  @Get("/runs", {
    summary: "List runs",
    description: "Every run, newest first, as a summary: id, title, status and node counts. Supports `If-None-Match`; an unchanged runs folder answers 304.",
  })
  @ResponseSchema(RunsEnvelopeDto.schema, { description: "The runs." })
  list_(c: ApiContext): Promise<Response> {
    return call(this.list, c);
  }

  @Get("/runs/{id}", {
    summary: "One run",
    description: "A run's full state: its plan and every node with status, harness, model, usage and cost. Answers 404 for an id that is malformed or does not exist, and 500 when state.json is corrupt.",
  })
  @Param(RunIdParamsDto.schema)
  @ResponseSchema(RunEnvelopeDto.schema, { description: "The run." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such run." })
  read_(c: ApiContext): Promise<Response> {
    return call(this.read, c);
  }

  @Post("/runs/{id}/retry", {
    summary: "Retry a run",
    description: "Retries the failed or cancelled nodes of a run through `dispatch.sh`.",
  })
  @Param(RunIdParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Retry started." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such run." })
  retry_(c: ApiContext): Promise<Response> {
    return call(this.retry, c);
  }

  @Post("/runs/{id}/stop", {
    summary: "Stop a run",
    description: "Stops a running run; its running nodes are marked cancelled.",
  })
  @Param(RunIdParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Stopped." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such run." })
  stop_(c: ApiContext): Promise<Response> {
    return call(this.stop, c);
  }

  @Post("/runs/{id}/nodes/{node}/retry", {
    summary: "Retry one node",
    description: "Retries a single failed node of a run.",
  })
  @Param(RunNodeParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Retry started." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such run or node." })
  retryNode_(c: ApiContext): Promise<Response> {
    return call(this.retryNode, c);
  }

  @Get("/jobs/{id}/log", {
    summary: "A job's log",
    description: "The tail of a background job's log. Supports `If-None-Match`. Answers 404 for an unknown or malformed job id.",
  })
  @Param(JobIdParamsDto.schema)
  @ResponseSchema(JobLogEnvelopeDto.schema, { description: "The log." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such job." })
  jobLog_(c: ApiContext): Promise<Response> {
    return call(this.jobLog, c);
  }

  @Get("/jobs/{id}/chat", {
    summary: "A job's conversation",
    description: "The conversation a job's harness kept, as turns with tool calls. Only the claude harness keeps one: any other job answers 404.",
  })
  @Param(JobIdParamsDto.schema)
  @ResponseSchema(ChatEnvelopeDto.schema, { description: "The turns." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such job, or its harness keeps no conversation." })
  jobChat_(c: ApiContext): Promise<Response> {
    return call(this.jobChat, c);
  }
}
