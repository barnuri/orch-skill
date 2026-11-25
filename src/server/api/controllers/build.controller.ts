import { Controller, Get, Post, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { BuildInfoDto, RestartAcceptedDto, RestartRefusedDto } from "../../../shared/dto/build";
import type { BuildInfo } from "../../../shared/types/build-info";
import { existsSync, watch } from "node:fs";

import type { DeployInfo } from "../../../shared/types/build-info";
import { BuildService, CACHE_MS } from "../../build/build-service";
import { deployDir, readDeployInfo } from "../../build/deploy-status";
import { MANUAL_COMMAND, REPO_ROOT, RESTART_DELAY_MS, Restarter, SERVICE_COMMAND } from "../../build/restart";
import { SwrCache } from "../../build/swr-cache";
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
  private readonly deploy: SwrCache<DeployInfo | null>;
  private deployHead: string | null = null;
  private deployWatched = false;

  constructor(private readonly ctx: ServerContext) {
    this.build = new BuildService({ root: REPO_ROOT });
    this.restarter = new Restarter(ctx.paths.home);
    this.deploy = new SwrCache<DeployInfo | null>(() => readDeployInfo(ctx.paths.home, REPO_ROOT), CACHE_MS);
  }

  /** Deploy info (two file reads and a git rev-list) from the background; a deploy-dir change or a new HEAD revalidates. */
  private deployInfo(head: string | null): DeployInfo | null {
    if (!this.deployWatched) {
      this.deployWatched = true;
      setImmediate(() => {
        const dir = deployDir(this.ctx.paths.home);
        if (existsSync(dir)) {
          try {
            watch(dir, { persistent: false }, () => this.deploy.invalidate()).on("error", () => {});
          } catch {
            // No watcher: the TTL still revalidates.
          }
        }
      });
    }
    if (head !== this.deployHead) {
      this.deployHead = head;
      this.deploy.invalidate();
    }
    return this.deploy.get(() => null);
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
    description: "Compares the git HEAD and source files at server start with now. Served from a cache computed in the background (30 s TTL, stale-while-revalidate; a HEAD or watched-file change revalidates), so the request never runs git; a failed check answers stale false with `error`. Also reports what a restart would interrupt.",
  })
  @ResponseSchema(BuildInfoDto.schema, { description: "The build state." })
  async getBuild(): Promise<Response> {
    const core = this.build.current();
    const deploy = this.deployInfo(core.head);
    return jsonResponse(200, { ...core, deploy, busy: this.busy() });
  }

  @Post("/build/restart", {
    summary: "Restart the service under its supervisor",
    description: "Schedules `scripts/service.ts restart` detached, about 1 s after the response. Answers 409 when the service is not installed or a restart was requested in the last 60 s.",
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
