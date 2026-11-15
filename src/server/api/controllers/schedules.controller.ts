import { Body, Controller, Get, Param, Post, Put, Query, Response as ResponseSchema } from "@barnuri/hono-decorators";

import type { ScheduleEdit, ScheduleInput } from "../../../shared/types/schedule";
import {
  createSchedule,
  editSchedule,
  listSchedulesHandler,
  schedulePreviewHandler,
  scheduleActionHandler,
  scheduleRunLogHandler,
} from "../../routes/schedule-routes";
import type { RouteHandler } from "../../http/route";
import type { ServerContext } from "../../types/server-context";
import { ErrorDto, OkDto } from "../../../shared/dto/common";
import {
  ScheduleActionParamsDto,
  ScheduleCreatedDto,
  ScheduleEditDto,
  ScheduleIdParamsDto,
  ScheduleInputDto,
  ScheduleLogDto,
  SchedulePreviewDto,
  SchedulePreviewQueryDto,
  ScheduleRunParamsDto,
  SchedulesEnvelopeDto,
} from "../../../shared/dto/schedule";
import type { ApiContext } from "../pipeline";
import { call, valid } from "./support";

@Controller({ path: "/api", tags: ["schedules"] })
export class SchedulesController {
  private readonly list: RouteHandler;
  private readonly preview: RouteHandler;
  private readonly action: RouteHandler;
  private readonly log: RouteHandler;

  constructor(private readonly ctx: ServerContext) {
    this.list = listSchedulesHandler(ctx);
    this.preview = schedulePreviewHandler(ctx);
    this.action = scheduleActionHandler(ctx);
    this.log = scheduleRunLogHandler(ctx);
  }

  @Get("/schedules", {
    summary: "List schedules",
    description: "Every schedule, newest first, each with its last 30 runs. A run still recorded as running is resolved from its exit marker, so the list is current without waiting for the 30 s tick. Supports `If-None-Match`.",
  })
  @ResponseSchema(SchedulesEnvelopeDto.schema, { description: "The schedules." })
  list_(c: ApiContext): Promise<Response> {
    return call(this.list, c);
  }

  @Post("/schedules", {
    summary: "Create a schedule",
    description: "Creates a schedule that runs a prompt (through a profile) or a shell command on a cron timetable. Answers 400 when the cron expression never matches, the profile is unknown, or a field required for the chosen kind is missing.",
  })
  @Body(ScheduleInputDto.schema)
  @ResponseSchema(ScheduleCreatedDto.schema, { status: 201, description: "Created." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Invalid schedule." })
  create(c: ApiContext): Promise<Response> {
    return createSchedule(this.ctx, valid<ScheduleInput>(c, "json"));
  }

  @Get("/schedules/preview", {
    summary: "Check a cron expression",
    description: "Validates a cron expression and names the next time it fires, in the machine's local time. The form calls this while you type.",
  })
  @Query(SchedulePreviewQueryDto.schema)
  @ResponseSchema(SchedulePreviewDto.schema, { description: "The next run." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Not a valid cron expression." })
  previewCron(c: ApiContext): Promise<Response> {
    return call(this.preview, c);
  }

  @Put("/schedules/{id}", {
    summary: "Change a schedule",
    description: "Changes the name, timetable, prompt, profile, command, working directory or time limit through `dispatch.sh schedule edit`. Omitted fields stay as they are; the id, creation time, paused state and run history are kept, and the next run is recomputed only when the timetable changes. Answers 400 with the CLI's message for an invalid value and 404 for a schedule that does not exist.",
  })
  @Param(ScheduleIdParamsDto.schema)
  @Body(ScheduleEditDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Changed." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Invalid change." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such schedule." })
  edit(c: ApiContext): Promise<Response> {
    return editSchedule(this.ctx, c.req.param("id") ?? "", valid<ScheduleEdit>(c, "json"));
  }

  @Get("/schedules/{id}/runs/{index}/log", {
    summary: "A run's output",
    description: "The last 64 KB of one run's output. `index` 0 is the newest run. Answers 400 for a malformed id or index and 404 for a schedule or run that does not exist.",
  })
  @Param(ScheduleRunParamsDto.schema)
  @ResponseSchema(ScheduleLogDto.schema, { description: "The output." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such schedule or run." })
  runLog(c: ApiContext): Promise<Response> {
    return call(this.log, c);
  }

  @Post("/schedules/{id}/{action}", {
    summary: "Run, pause, resume or delete a schedule",
    description: "`run` starts a run now, outside the timetable. `disable` pauses it, `enable` resumes it, `remove` deletes it and its history. Answers 400 for an unknown action or malformed id and 404 for a schedule that does not exist.",
  })
  @Param(ScheduleActionParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Done." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Unknown action or malformed id." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such schedule." })
  act(c: ApiContext): Promise<Response> {
    return call(this.action, c);
  }
}
