import { Controller, Get, Post, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { BuildInfoDto, RestartAcceptedDto, RestartRefusedDto } from "../../../shared/dto/build";
import type { BuildInfo } from "../../../shared/types/build-info";
import { BuildService } from "../../build/build-service";
import { MANUAL_COMMAND, REPO_ROOT, RESTART_DELAY_MS, Restarter, SERVICE_COMMAND } from "../../build/restart";
import { chatServiceFor } from "../../chats/service";
import { jsonResponse } from "../../http/responses";
import { listRuns } from "../../runs/runs-reader";
import type { ServerContext } from "../../types/server-context";

const BUSY_TTL_MS = 3000;

@Controller({ path: "/api", tags: ["build"] })
export class BuildController {
  private readonly build: BuildService;
  private readonly restarter: Restarter;
  private busyCache: { at: number; value: BuildInfo["busy"] } | null = null;

  constructor(private readonly ctx: ServerContext) {
    this.build = new BuildService({ root: REPO_ROOT });
    this.restarter = new Restarter(ctx.paths.home);
  }

  private busy(): BuildInfo["busy"] {
    if (this.busyCache !== null && Date.now() - this.busyCache.at < BUSY_TTL_MS) {
      return this.busyCache.value;
    }
    let chats = 0;
    let runs = 0;
    try {
      chats = chatServiceFor(this.ctx).store.listChats({ limit: 100 }).items.filter((c) => c.status === "running").length;
    } catch {
      chats = 0;
    }
    try {
      runs = listRuns(this.ctx.paths).reduce((sum, r) => sum + r.counts.running, 0);
    } catch {
      runs = 0;
    }
    this.busyCache = { at: Date.now(), value: { chats_streaming: chats, runs_running: runs } };
    return this.busyCache.value;
  }

  @Get("/build", {
    summary: "Does the running server include the latest code?",
    description: "Compares the git HEAD and source files at server start with now. Cached for 10 s; a failed check answers stale false with `error`. Also reports what a restart would interrupt.",
  })
  @ResponseSchema(BuildInfoDto.schema, { description: "The build state." })
  async getBuild(): Promise<Response> {
    const core = await this.build.check();
    return jsonResponse(200, { ...core, busy: this.busy() });
  }

  @Post("/build/restart", {
    summary: "Restart the service under its supervisor",
    description: "Schedules `scripts/service.sh restart` detached, about 1 s after the response. Answers 409 when the service is not installed or a restart was requested in the last 60 s.",
  })
  @ResponseSchema(RestartAcceptedDto.schema, { status: 202, description: "The restart is scheduled." })
  @ResponseSchema(RestartRefusedDto.schema, { status: 409, description: "Not installed, or already requested." })
  async restart(): Promise<Response> {
    const outcome = await this.restarter.request();
    if (outcome.kind === "accepted") {
      return jsonResponse(202, { ok: true, restart_in_ms: RESTART_DELAY_MS });
    }
    if (outcome.kind === "already") {
      return jsonResponse(409, { error: "restart already requested", command: SERVICE_COMMAND });
    }
    return jsonResponse(409, { error: "service not installed", command: MANUAL_COMMAND });
  }
}
