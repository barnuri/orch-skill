import { Body, Controller, Delete, Get, Param, Post, Put, Query, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { ErrorDto, OkDto } from "../../../shared/dto/common";
import { ChatIdParamsDto } from "../../../shared/dto/chats";
import {
  WorkspaceAreaParamsDto, WorkspaceDto, WorkspaceFileParamsDto, WorkspaceFilesDto, WorkspaceMemoryDto, WorkspaceMemoryInputDto, WorkspaceScopeQueryDto,
} from "../../../shared/dto/workspace";
import { type ChatService, chatServiceFor } from "../../chats/service";
import { cleanName, MAX_WORKSPACE_UPLOAD, type Scope, type Workspace, WorkspaceError, type WorkspaceFile } from "../../chats/workspace";
import { jsonResponse } from "../../http/responses";
import type { ServerContext } from "../../types/server-context";
import type { ApiContext } from "../pipeline";
import { failure, idOf } from "./projects.controller";
import { valid } from "./support";
import { isArea, AREAS } from "../../chats/workspace";

function guarded(work: () => Response | Promise<Response>): Promise<Response> {
  return Promise.resolve()
    .then(work)
    .catch((err: unknown) => (err instanceof WorkspaceError ? jsonResponse(err.status, { error: err.message }) : failure(err)));
}

/** Reads a request body, refusing more than `cap` bytes without holding the excess. */
async function readCapped(req: Request, cap: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > cap) {
    throw new WorkspaceError(413, `the upload is larger than ${MAX_WORKSPACE_UPLOAD / (1024 * 1024)} MB`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body !== null) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (total > cap) {
        await reader.cancel();
        throw new WorkspaceError(413, `the upload is larger than ${MAX_WORKSPACE_UPLOAD / (1024 * 1024)} MB`);
      }
      chunks.push(value);
    }
  }
  return new Uint8Array(Buffer.concat(chunks));
}

@Controller({ path: "/api", tags: ["workspace"] })
export class WorkspaceController {
  private readonly service: ChatService;

  constructor(ctx: ServerContext) {
    this.service = chatServiceFor(ctx);
  }

  private ws(c: ApiContext, id: string = idOf(c)): Workspace {
    const scope = valid<{ scope?: Scope }>(c, "query").scope ?? "chat";
    return this.service.workspace(this.service.chat(id), scope);
  }

  @Get("/chats/{id}/workspace", {
    summary: "A chat's workspace",
    description: "Where the workspace is and what it holds. `scope=chat` (default) is `<folder>/.orch/chats/<chat id>/`, or `<orch home>/chats/data/<chat id>/` for a chat without a folder. `scope=folder` is `<folder>/.orch/shared/`, shared by every chat of the folder, and answers 400 when the chat has no folder. Reading never creates the directory.",
  })
  @Param(ChatIdParamsDto.schema)
  @Query(WorkspaceScopeQueryDto.schema)
  @ResponseSchema(WorkspaceDto.schema, { description: "The workspace." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "The chat has no folder." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such chat." })
  read(c: ApiContext): Promise<Response> {
    return guarded(() => {
      const chat = this.service.chat(idOf(c));
      const ws = this.ws(c);
      const memory = ws.readMemory();
      return jsonResponse(200, {
        scope: ws.scope,
        path: ws.root,
        exists: ws.exists(),
        has_folder: this.service.usableCwd(chat) !== null,
        moved_from: ws.scope === "chat" ? ws.movedFrom() : null,
        memory_size: Buffer.byteLength(memory.content),
        files: { knowledge: ws.list("knowledge"), artifacts: ws.list("artifacts") },
      });
    });
  }

  @Get("/chats/{id}/workspace/memory", { summary: "Read MEMORY.md", description: "The memory file of a workspace; empty when it does not exist." })
  @Param(ChatIdParamsDto.schema)
  @Query(WorkspaceScopeQueryDto.schema)
  @ResponseSchema(WorkspaceMemoryDto.schema, { description: "The memory." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Folder scope without a folder." })
  memory(c: ApiContext): Promise<Response> {
    return guarded(() => jsonResponse(200, this.ws(c).readMemory()));
  }

  @Put("/chats/{id}/workspace/memory", { summary: "Write MEMORY.md", description: "Replaces the file (creating the workspace when needed). More than 200 KB answers 413." })
  @Param(ChatIdParamsDto.schema)
  @Query(WorkspaceScopeQueryDto.schema)
  @Body(WorkspaceMemoryInputDto.schema)
  @ResponseSchema(WorkspaceMemoryDto.schema, { description: "The saved memory." })
  @ResponseSchema(ErrorDto.schema, { status: 413, description: "Too large." })
  writeMemory(c: ApiContext): Promise<Response> {
    return guarded(() => {
      const ws = this.ws(c);
      ws.writeMemory(valid<{ content: string }>(c, "json").content);
      return jsonResponse(200, ws.readMemory());
    });
  }

  @Get("/chats/{id}/workspace/export", { summary: "Download a workspace as a zip", description: "Memory, knowledge, artifacts and chat.json; the `.trash` folder is left out." })
  @Param(ChatIdParamsDto.schema)
  @Query(WorkspaceScopeQueryDto.schema)
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Folder scope without a folder." })
  exportZip(c: ApiContext): Promise<Response> {
    return guarded(() => {
      const chat = this.service.chat(idOf(c));
      const ws = this.ws(c);
      const name = `${ws.scope === "chat" ? chat.id : "folder"}-workspace.zip`;
      return new Response((ws.zip() as unknown as BodyInit), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } });
    });
  }

  @Get("/chats/{id}/workspace/files/{area}/{name}", { summary: "Read a workspace file", description: "Images and text are shown inline (text as text/plain), everything else downloads; `download=1` always downloads. Symbolic links are never served." })
  @Param(WorkspaceFileParamsDto.schema)
  @Query(WorkspaceScopeQueryDto.schema)
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such file." })
  file(c: ApiContext): Promise<Response> {
    return guarded(() => {
      const { area, name } = valid<{ area: string; name: string }>(c, "param");
      const download = valid<{ download?: string }>(c, "query").download === "1";
      return this.ws(c).serve(this.area(area), name, download);
    });
  }

  @Post("/chats/{id}/workspace/files/{area}", {
    summary: "Upload files to a workspace",
    description: "`multipart/form-data` with one or more files, or a raw body with `X-Filename` (URL-encoded). 20 MB per file. A file with an existing name replaces it. Names with a separator or a leading dot are refused.",
  })
  @Param(WorkspaceAreaParamsDto.schema)
  @Query(WorkspaceScopeQueryDto.schema)
  @ResponseSchema(WorkspaceFilesDto.schema, { status: 201, description: "Stored." })
  @ResponseSchema(ErrorDto.schema, { status: 413, description: "A file is too large." })
  upload(c: ApiContext): Promise<Response> {
    return guarded(async () => {
      const ws = this.ws(c);
      const area = this.area(valid<{ area: string }>(c, "param").area);
      const req = c.req.raw;
      const type = req.headers.get("content-type") ?? "";
      const body = await readCapped(req, MAX_WORKSPACE_UPLOAD + (type.startsWith("multipart/") ? 64 * 1024 : 0));
      const items: WorkspaceFile[] = [];
      if (type.startsWith("multipart/")) {
        let form: FormData;
        try {
          form = await new Response((body as unknown as BodyInit), { headers: { "Content-Type": type } }).formData();
        } catch {
          throw new WorkspaceError(400, "malformed multipart body");
        }
        for (const entry of form.values()) {
          const value: unknown = entry;
          if (value instanceof File) {
            items.push(ws.save(area, value.name, new Uint8Array(await value.arrayBuffer())));
          }
        }
      } else {
        const header = req.headers.get("x-filename");
        if (header === null) {
          throw new WorkspaceError(400, "X-Filename header is missing");
        }
        let name = header;
        try {
          name = decodeURIComponent(header);
        } catch {
          // keep as sent
        }
        items.push(ws.save(area, cleanName(name), body));
      }
      if (items.length === 0) {
        throw new WorkspaceError(400, "no files in the request");
      }
      return jsonResponse(201, { items });
    });
  }

  @Delete("/chats/{id}/workspace/files/{area}/{name}", { summary: "Move a workspace file to the trash", description: "Moves the file into the workspace's `.trash/` folder; nothing is deleted." })
  @Param(WorkspaceFileParamsDto.schema)
  @Query(WorkspaceScopeQueryDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Moved." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such file." })
  remove(c: ApiContext): Promise<Response> {
    return guarded(() => {
      const { area, name } = valid<{ area: string; name: string }>(c, "param");
      this.ws(c).trash(this.area(area), name);
      return jsonResponse(200, { ok: true });
    });
  }

  private area(value: string): (typeof AREAS)[number] {
    if (!isArea(value)) {
      throw new WorkspaceError(400, "area: knowledge or artifacts");
    }
    return value;
  }
}
