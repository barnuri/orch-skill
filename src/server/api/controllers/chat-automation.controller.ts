import { Body, Controller, Delete, Get, Param, Patch, Post, Response as ResponseSchema } from "@barnuri/hono-decorators";

import {
  ChatItemActionParamsDto, ChatItemCreatedDto, ChatItemLogDto, ChatItemParamsDto, ChatItemsDto, ChatLoopInputDto, ChatMonitorInputDto, ChatScheduleInputDto,
  ChatSchedulePatchDto,
} from "../../../shared/dto/chat-automation";
import { ChatIdParamsDto } from "../../../shared/dto/chats";
import { ErrorDto, OkDto } from "../../../shared/dto/common";
import { type ChatAutomation, automationFor, type LoopInput, type MonitorInput, type ScheduleCreate } from "../../chats/automation";
import { HttpError } from "../../chats/service";
import { jsonResponse } from "../../http/responses";
import type { ServerContext } from "../../types/server-context";
import type { ApiContext } from "../pipeline";
import { failure, idOf } from "./projects.controller";
import { valid } from "./support";

const iidOf = (c: ApiContext): string => c.req.param("iid") as string;

function guarded(work: () => Promise<Response> | Response): Promise<Response> {
  return Promise.resolve().then(work).catch((err: unknown) => failure(err));
}

@Controller({ path: "/api", tags: ["chats"] })
export class ChatAutomationController {
  private readonly auto: ChatAutomation;

  constructor(ctx: ServerContext) {
    this.auto = automationFor(ctx);
  }

  @Post("/chats/{id}/read", { summary: "Mark a chat read", description: "Clears the unread dot a schedule, loop or monitor left." })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Done." })
  read(c: ApiContext): Promise<Response> {
    return guarded(() => {
      this.auto.markRead(idOf(c));
      return jsonResponse(200, { ok: true });
    });
  }

  // ---- schedules

  @Get("/chats/{id}/schedules", { summary: "A chat's schedules", description: "The schedules whose result returns to this chat, with their last runs. Newest first." })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(ChatItemsDto.schema, { description: "The schedules." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such chat." })
  listSchedules(c: ApiContext): Promise<Response> {
    return guarded(() => jsonResponse(200, { items: this.auto.schedulesOf(this.auto.known(idOf(c))) }));
  }

  @Post("/chats/{id}/schedules", {
    summary: "Save a schedule from this chat",
    description: "Creates a schedule whose prompt runs in this chat on a cron timetable in `timezone`. `message` mode appends the prompt as a message marked `Scheduled: <name>` (it waits in the chat's queue when a reply runs); `fresh` runs it in a new session and posts the answer back. At least 5 minutes between runs; at most 50 active chat schedules in all.",
  })
  @Param(ChatIdParamsDto.schema)
  @Body(ChatScheduleInputDto.schema)
  @ResponseSchema(ChatItemCreatedDto.schema, { status: 201, description: "Created." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Invalid schedule." })
  @ResponseSchema(ErrorDto.schema, { status: 409, description: "The chat is archived or the limit is reached." })
  createSchedule(c: ApiContext): Promise<Response> {
    return guarded(async () => jsonResponse(201, await this.auto.createSchedule(idOf(c), valid<ScheduleCreate>(c, "json"))));
  }

  @Patch("/chats/{id}/schedules/{iid}", { summary: "Change a chat schedule", description: "Name, prompt, cron, time zone, mode, or `enabled` to pause and resume." })
  @Param(ChatItemParamsDto.schema)
  @Body(ChatSchedulePatchDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Changed." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such schedule in this chat." })
  editSchedule(c: ApiContext): Promise<Response> {
    return guarded(async () => {
      await this.auto.editSchedule(idOf(c), iidOf(c), valid(c, "json"));
      return jsonResponse(200, { ok: true });
    });
  }

  @Delete("/chats/{id}/schedules/{iid}", { summary: "Delete a chat schedule", description: "Moves the schedule and its history to the trash." })
  @Param(ChatItemParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Deleted." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such schedule in this chat." })
  deleteSchedule(c: ApiContext): Promise<Response> {
    return guarded(async () => {
      await this.auto.deleteSchedule(idOf(c), iidOf(c));
      return jsonResponse(200, { ok: true });
    });
  }

  @Post("/chats/{id}/schedules/{iid}/{action}", { summary: "Run now, pause, resume or read the log of a chat schedule", description: "`run-now` fires it once outside the timetable and answers when the run is recorded. `pause` and `resume` switch it. `log` is a GET: use GET .../log." })
  @Param(ChatItemActionParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Done." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such schedule in this chat." })
  scheduleAction(c: ApiContext): Promise<Response> {
    return guarded(async () => {
      const action = c.req.param("action");
      if (action === "run-now") await this.auto.runNow(idOf(c), iidOf(c));
      else if (action === "pause") await this.auto.setScheduleEnabled(idOf(c), iidOf(c), false);
      else if (action === "resume") await this.auto.setScheduleEnabled(idOf(c), iidOf(c), true);
      else throw new HttpError(400, "action must be run-now, pause or resume");
      return jsonResponse(200, { ok: true });
    });
  }

  @Get("/chats/{id}/schedules/{iid}/log", { summary: "A chat schedule's last runs", description: "The last 20 runs: time, status, error or note, and the posted message." })
  @Param(ChatItemParamsDto.schema)
  @ResponseSchema(ChatItemLogDto.schema, { description: "The runs." })
  scheduleLog(c: ApiContext): Promise<Response> {
    return guarded(() => jsonResponse(200, { entries: this.auto.scheduleLog(idOf(c), iidOf(c)) }));
  }

  // ---- loops

  @Get("/chats/{id}/loops", { summary: "A chat's loops", description: "The loops whose iterations are posted into this chat, newest first." })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(ChatItemsDto.schema, { description: "The loops." })
  listLoops(c: ApiContext): Promise<Response> {
    return guarded(() => jsonResponse(200, { items: this.auto.loopsOf(this.auto.known(idOf(c))) }));
  }

  @Post("/chats/{id}/loops", {
    summary: "Start a loop from this chat",
    description: "Starts the orch loop engine with this chat as its target: each iteration's answer is posted into the chat. Stops on its condition, at `max`, on Stop, or after 3 failures in a row.",
  })
  @Param(ChatIdParamsDto.schema)
  @Body(ChatLoopInputDto.schema)
  @ResponseSchema(ChatItemCreatedDto.schema, { status: 201, description: "Started." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Invalid loop." })
  createLoop(c: ApiContext): Promise<Response> {
    return guarded(async () => jsonResponse(201, await this.auto.createLoop(idOf(c), valid<LoopInput>(c, "json"))));
  }

  @Post("/chats/{id}/loops/{iid}/{action}", { summary: "Stop or resume a loop", description: "`stop` and `pause` end the loop's process; `resume` starts a stopped loop again. `run-now` is not supported (409): a loop follows its own interval." })
  @Param(ChatItemActionParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Done." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such loop in this chat." })
  loopAction(c: ApiContext): Promise<Response> {
    return guarded(async () => {
      const action = c.req.param("action");
      if (action === "stop" || action === "pause") await this.auto.stopLoop(idOf(c), iidOf(c));
      else if (action === "resume") await this.auto.resumeLoop(idOf(c), iidOf(c));
      else throw new HttpError(409, "a loop follows its own interval; it cannot run now");
      return jsonResponse(200, { ok: true });
    });
  }

  @Get("/chats/{id}/loops/{iid}/log", { summary: "A loop's last iterations", description: "The tail of the last 20 iterations' output." })
  @Param(ChatItemParamsDto.schema)
  @ResponseSchema(ChatItemLogDto.schema, { description: "The iterations." })
  loopLog(c: ApiContext): Promise<Response> {
    return guarded(() => jsonResponse(200, { entries: this.auto.loopLog(idOf(c), iidOf(c)) }));
  }

  // ---- monitors

  @Get("/chats/{id}/monitors", { summary: "A chat's monitors", description: "The monitors that post into this chat, newest first." })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(ChatItemsDto.schema, { description: "The monitors." })
  listMonitors(c: ApiContext): Promise<Response> {
    return guarded(() => jsonResponse(200, { items: this.auto.monitorsOf(this.auto.known(idOf(c))) }));
  }

  @Post("/chats/{id}/monitors", {
    summary: "Start a monitor from this chat",
    description: "Watches a file or folder, a URL (http or https only; link-local and metadata addresses are blocked), a command, a command's output, an orch run or a git repo, and posts into the chat when it changes or matches. At most 20 active per chat. Intervals: at least 10 s for local checks, 60 s for URLs. Answers 400 for an invalid or blocked target and 409 at the limit.",
  })
  @Param(ChatIdParamsDto.schema)
  @Body(ChatMonitorInputDto.schema)
  @ResponseSchema(ChatItemCreatedDto.schema, { status: 201, description: "Started." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Invalid or blocked monitor." })
  @ResponseSchema(ErrorDto.schema, { status: 409, description: "The chat has 20 active monitors." })
  createMonitor(c: ApiContext): Promise<Response> {
    return guarded(async () => jsonResponse(201, await this.auto.createMonitor(idOf(c), valid<MonitorInput>(c, "json"))));
  }

  @Post("/chats/{id}/monitors/{iid}/{action}", { summary: "Stop, pause, resume or check a monitor now", description: "`stop` and `pause` end it; `resume` starts an equal one that replaces it in the list; `run-now` runs the check once and posts what it saw." })
  @Param(ChatItemActionParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Done." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such monitor in this chat." })
  monitorAction(c: ApiContext): Promise<Response> {
    return guarded(async () => {
      const action = c.req.param("action");
      if (action === "stop" || action === "pause") await this.auto.stopMonitor(idOf(c), iidOf(c));
      else if (action === "resume") return jsonResponse(200, { ok: true, ...(await this.auto.resumeMonitor(idOf(c), iidOf(c))) });
      else if (action === "run-now") await this.auto.checkNow(idOf(c), iidOf(c));
      else throw new HttpError(400, "unknown action");
      return jsonResponse(200, { ok: true });
    });
  }

  @Get("/chats/{id}/monitors/{iid}/log", { summary: "A monitor's last triggers", description: "The last 20 events it recorded." })
  @Param(ChatItemParamsDto.schema)
  @ResponseSchema(ChatItemLogDto.schema, { description: "The events." })
  monitorLog(c: ApiContext): Promise<Response> {
    return guarded(() => jsonResponse(200, { entries: this.auto.monitorLog(idOf(c), iidOf(c)) }));
  }
}
