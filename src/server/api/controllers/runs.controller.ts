import { Body, Controller, Get, Param, Post, Query, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { jsonResponse } from "../../http/responses";
import type { RouteHandler } from "../../http/route";
import { isRunId } from "../../runs/run-id";
import { runLiveStream } from "../../runs/run-live-sse";
import {
  answerNode,
  cancelNodeHandler,
  listRunsHandler,
  readJobChatHandler,
  readJobLogHandler,
  readNodeActivityHandler,
  readRunEventsHandler,
  readRunMessagesHandler,
  pauseRunHandler,
  readRunHandler,
  retryNodeHandler,
  resumeRunHandler,
  retryRunHandler,
  stopRunHandler,
  tellNode,
} from "../../routes/runs-routes";
import { repointRun } from "../../routes/runs-routes";
import type { NodeMessageInput } from "../../routes/runs-routes";
import type { ServerContext } from "../../types/server-context";
import { ErrorDto, OkDto } from "../../../shared/dto/common";
import { ChatEnvelopeDto, JobIdParamsDto, RunEventsEnvelopeDto, RunEventsQueryDto, NodeActivityQueryDto, NodeActivityEnvelopeDto, NodeMessageInputDto, RunMessagesEnvelopeDto, JobLogEnvelopeDto, RepointInputDto, RunEnvelopeDto, RunIdParamsDto, RunNodeParamsDto, RunsEnvelopeDto } from "../../../shared/dto/runs";
import type { ApiContext } from "../pipeline";
import { call, valid } from "./support";

@Controller({ path: "/api", tags: ["runs"] })
export class RunsController {
  private readonly list: RouteHandler;
  private readonly read: RouteHandler;
  private readonly retry: RouteHandler;
  private readonly stop: RouteHandler;
  private readonly pause: RouteHandler;
  private readonly cancelNode: RouteHandler;
  private readonly resume: RouteHandler;
  private readonly retryNode: RouteHandler;
  private readonly jobLog: RouteHandler;
  private readonly jobChat: RouteHandler;
  private readonly events: RouteHandler;
  private readonly activity: RouteHandler;
  private readonly messages: RouteHandler;
  private readonly ctx: ServerContext;

  constructor(ctx: ServerContext) {
    this.list = listRunsHandler(ctx);
    this.read = readRunHandler(ctx);
    this.retry = retryRunHandler(ctx);
    this.stop = stopRunHandler(ctx);
    this.pause = pauseRunHandler(ctx);
    this.cancelNode = cancelNodeHandler(ctx);
    this.resume = resumeRunHandler(ctx);
    this.retryNode = retryNodeHandler(ctx);
    this.jobLog = readJobLogHandler(ctx);
    this.jobChat = readJobChatHandler(ctx);
    this.events = readRunEventsHandler(ctx);
    this.activity = readNodeActivityHandler(ctx);
    this.messages = readRunMessagesHandler(ctx);
    this.ctx = ctx;
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

  @Get("/runs/{id}/events", {
    summary: "A run's activity feed",
    description: "One event per node or run change, oldest first, at most 200 (the newest). `after=N` returns only events past the cursor `next` of the previous answer.",
  })
  @Param(RunIdParamsDto.schema)
  @Query(RunEventsQueryDto.schema)
  @ResponseSchema(RunEventsEnvelopeDto.schema, { description: "The events." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such run." })
  events_(c: ApiContext): Promise<Response> {
    return call(this.events, c);
  }

  @Get("/runs/{id}/live", {
    summary: "Follow a run live (Server-Sent Events)",
    description: "A `text/event-stream` with one `node` event (`{run, node, from, to, at}`) each time a node of the run turns done or error. The server's run engine sends it within about 200 ms of the state.json write. No replay: refetch the run after a reconnect.",
  })
  @Param(RunIdParamsDto.schema)
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "Malformed run id." })
  live_(c: ApiContext): Response {
    const id = c.req.param("id") ?? "";
    return isRunId(id) ? runLiveStream(id, c.req.raw.signal) : jsonResponse(404, { error: "no such run" });
  }

  @Get("/runs/{id}/nodes/{node}/activity", {
    summary: "A node owner's live activity",
    description: "For a node owned by an opencode session: its last 20 messages as a bounded summary (text, tool, reasoning; at most 8 KB). `after=<message id>` returns only newer messages. `state` is `unknown` when opencode is unreachable. Answers 404 when the node has no checkable owner.",
  })
  @Param(RunNodeParamsDto.schema)
  @Query(NodeActivityQueryDto.schema)
  @ResponseSchema(NodeActivityEnvelopeDto.schema, { description: "The activity." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such run or node, or no checkable owner." })
  activity_(c: ApiContext): Promise<Response> {
    return call(this.activity, c);
  }

  @Post("/runs/{id}/retry", {
    summary: "Retry a run",
    description: "Retries the failed or cancelled nodes of a run through `dispatch.ts`.",
  })
  @Param(RunIdParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Retry started." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such run." })
  retry_(c: ApiContext): Promise<Response> {
    return call(this.retry, c);
  }

  @Post("/runs/{id}/stop", {
    summary: "Stop a run",
    description: "Stops a run: kills its running jobs, marks those nodes `stopped` and sets `stopped: true`. A stopped run never auto-resumes.",
  })
  @Param(RunIdParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Stopped." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such run." })
  stop_(c: ApiContext): Promise<Response> {
    return call(this.stop, c);
  }

  @Post("/runs/{id}/pause", {
    summary: "Pause a run",
    description: "Runs `run pause <id>`: sets `paused: true`. A paused run starts no node until it is resumed. Its running nodes are re-dispatched by resume when their process is gone.",
  })
  @Param(RunIdParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Paused." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such run." })
  pause_(c: ApiContext): Promise<Response> {
    return call(this.pause, c);
  }

  @Post("/runs/{id}/resume", {
    summary: "Resume a stopped run",
    description: "Runs `run resume <id> --stopped`: clears `stopped` and re-dispatches the stopped nodes with their sessions.",
  })
  @Param(RunIdParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Resumed." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such run." })
  resume_(c: ApiContext): Promise<Response> {
    return call(this.resume, c);
  }

  @Post("/runs/{id}/nodes/{node}/cancel", {
    summary: "Cancel one node",
    description: "Runs `node cancel <id> <node>`: kills the node's running job and marks only that node `stopped`. The CLI refuses a node that is not running.",
  })
  @Param(RunNodeParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Cancelled." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such run or node." })
  cancelNode_(c: ApiContext): Promise<Response> {
    return call(this.cancelNode, c);
  }

  @Get("/runs/{id}/messages", {
    summary: "A run's messages",
    description: "Every inbox message of the run, oldest first: tells and answers to nodes, asks from nodes (with `answer` once answered). An unknown run has none.",
  })
  @Param(RunIdParamsDto.schema)
  @ResponseSchema(RunMessagesEnvelopeDto.schema, { description: "The messages." })
  messages_(c: ApiContext): Promise<Response> {
    return call(this.messages, c);
  }

  @Post("/runs/{id}/repoint", {
    summary: "Choose the coordinator",
    description: "Runs `run repoint <id> <socket> <pane>`: points an unreachable coordinator at one of its listed candidates; the pending asks are delivered on the next sweep.",
  })
  @Param(RunIdParamsDto.schema)
  @Body(RepointInputDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Repointed." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Not a candidate pane, or no such run." })
  repoint_(c: ApiContext): Promise<Response> {
    return repointRun(this.ctx, c.req.param("id") ?? "", valid<{ socket_path: string; pane_id: string }>(c, "json"));
  }

  @Post("/runs/{id}/nodes/{node}/tell", {
    summary: "Send a message to a node",
    description: "Runs `node tell <id> <node> <text> --from user`: pushes the text into the node's herdr pane when it has one, else leaves it in the node's inbox. `output` is `<msg-id> <node> delivered|pending`.",
  })
  @Param(RunNodeParamsDto.schema)
  @Body(NodeMessageInputDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Sent." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "No such run or node, or empty text." })
  tell_(c: ApiContext): Promise<Response> {
    return tellNode(this.ctx, c.req.param("id") ?? "", c.req.param("node") ?? "", valid<NodeMessageInput>(c, "json"));
  }

  @Post("/runs/{id}/nodes/{node}/answer", {
    summary: "Answer a node's question",
    description: "Runs `node answer <id> <node> <text> --from user [--ask <id>]`: stores the answer on the ask (a `node ask --wait` prints it) and sends the node an `answer` message. Without `ask`, answers the node's oldest open ask.",
  })
  @Param(RunNodeParamsDto.schema)
  @Body(NodeMessageInputDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Answered." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "No open ask, already answered, or no such run or node." })
  answer_(c: ApiContext): Promise<Response> {
    return answerNode(this.ctx, c.req.param("id") ?? "", c.req.param("node") ?? "", valid<NodeMessageInput>(c, "json"));
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
