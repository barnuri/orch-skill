import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Body, Controller, Get, Param, Post, Put, Query, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { ErrorDto } from "../../../shared/dto/common";
import {
  ChatIdParamsDto, ProjectDto, ProjectEnvelopeDto, ProjectInputDto, ProjectPageDto, ProjectsQueryDto, ProjectUpdateDto,
} from "../../../shared/dto/chats";
import { type ChatService, chatServiceFor, HttpError } from "../../chats/service";
import { jsonResponse } from "../../http/responses";
import type { ServerContext } from "../../types/server-context";
import type { ApiContext } from "../pipeline";
import { valid } from "./support";

export function idOf(c: ApiContext): string {
  return c.req.param("id") as string;
}

export function failure(err: unknown): Response {
  if (err instanceof HttpError) {
    return jsonResponse(err.status, { error: err.message });
  }
  throw err;
}

function checkPath(path: string | null | undefined): void {
  if (path === null || path === undefined || path === "") {
    return;
  }
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) {
    throw new HttpError(400, "path: must be an existing absolute directory");
  }
}

@Controller({ path: "/api", tags: ["projects"] })
export class ProjectsController {
  private readonly service: ChatService;

  constructor(ctx: ServerContext) {
    this.service = chatServiceFor(ctx);
  }

  @Get("/projects", {
    summary: "List projects",
    description: "Active projects, newest first, paged by cursor (default 30, max 100). `archived=1` includes archived ones.",
  })
  @Query(ProjectsQueryDto.schema)
  @ResponseSchema(ProjectPageDto.schema, { description: "A page of projects." })
  list(c: ApiContext): Response {
    const q = valid<{ limit?: number; cursor?: string; archived?: string }>(c, "query");
    return jsonResponse(200, this.service.store.listProjects({ includeArchived: q.archived === "1" || q.archived === "true", limit: q.limit, cursor: q.cursor }));
  }

  @Post("/projects", {
    summary: "Create a project",
    description: "A project groups chats. `path`, when given, must be an existing absolute directory; chats of the project run there.",
  })
  @Body(ProjectInputDto.schema)
  @ResponseSchema(ProjectDto.schema, { status: 201, description: "Created." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Invalid project." })
  create(c: ApiContext): Response {
    try {
      const body = valid<{ name: string; path?: string | null; description?: string }>(c, "json");
      checkPath(body.path);
      return jsonResponse(201, this.service.store.createProject(body));
    } catch (err) {
      return failure(err);
    }
  }

  @Get("/projects/{id}", {
    summary: "Read a project",
    description: "One project, archived or not.",
  })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(ProjectDto.schema, { description: "The project." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such project." })
  read(c: ApiContext): Response {
    try {
      return jsonResponse(200, this.service.project(idOf(c)));
    } catch (err) {
      return failure(err);
    }
  }

  @Put("/projects/{id}", {
    summary: "Change a project",
    description: "Changes the name, path or description. Omitted fields stay as they are.",
  })
  @Param(ChatIdParamsDto.schema)
  @Body(ProjectUpdateDto.schema)
  @ResponseSchema(ProjectDto.schema, { description: "The project after the change." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Invalid change." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such project." })
  update(c: ApiContext): Response {
    try {
      const body = valid<{ name?: string; path?: string | null; description?: string }>(c, "json");
      this.service.project(idOf(c));
      checkPath(body.path);
      return jsonResponse(200, this.service.store.updateProject(idOf(c), body));
    } catch (err) {
      return failure(err);
    }
  }

  @Post("/projects/{id}/archive", {
    summary: "Archive a project",
    description: "Hides the project from the default list. Nothing is deleted; its chats and history stay.",
  })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(ProjectEnvelopeDto.schema, { description: "The archived project." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such project." })
  archive(c: ApiContext): Response {
    return this.setArchived(c, true);
  }

  @Post("/projects/{id}/unarchive", {
    summary: "Restore a project",
    description: "Brings an archived project back into the default list.",
  })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(ProjectEnvelopeDto.schema, { description: "The restored project." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such project." })
  unarchive(c: ApiContext): Response {
    return this.setArchived(c, false);
  }

  private setArchived(c: ApiContext, archived: boolean): Response {
    try {
      this.service.project(idOf(c));
      return jsonResponse(200, { project: this.service.store.setProjectArchived(idOf(c), archived) });
    } catch (err) {
      return failure(err);
    }
  }
}
