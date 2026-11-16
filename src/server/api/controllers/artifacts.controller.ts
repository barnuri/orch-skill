import { randomBytes } from "node:crypto";
import { Body, Controller, Get, Param, Post, Put, Query, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { ChatIdParamsDto } from "../../../shared/dto/chats";
import {
  ArtifactContentQueryDto, ArtifactListDto, ArtifactParamsDto, ArtifactRestoreDto, ArtifactSavedDto, ArtifactSettingsDto, ArtifactVersionsDto, ArtifactViewDto, ArtifactViewInputDto, ArtifactWriteDto,
} from "../../../shared/dto/artifacts";
import { ErrorDto } from "../../../shared/dto/common";
import { kindOf, PREVIEW_LIMIT } from "../../../shared/artifacts";
import { hostAllowed } from "../../http/host-policy";
import { readSettings, writeSettings } from "../../chats/artifacts";
import { type ChatService, chatServiceFor } from "../../chats/service";
import { detectMime } from "../../chats/uploads";
import { WorkspaceError } from "../../chats/workspace";
import { jsonResponse } from "../../http/responses";
import type { ServerContext } from "../../types/server-context";
import type { ApiContext } from "../pipeline";
import { failure, idOf } from "./projects.controller";
import { valid } from "./support";

function guarded(work: () => Response | Promise<Response>): Promise<Response> {
  return Promise.resolve()
    .then(work)
    .catch((err: unknown) => (err instanceof WorkspaceError ? jsonResponse(err.status, { error: err.message }) : failure(err)));
}

const VIEW_TTL_MS = 30 * 60 * 1000;

/** What a framed HTML artifact may do: run its own scripts and styles, show inline images, and reach nothing else. */
export const VIEW_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

@Controller({ path: "/api", tags: ["artifacts"] })
export class ArtifactsController {
  private readonly service: ChatService;
  private readonly home: string;
  private readonly views = new Map<string, { chatId: string; name: string; version: number | undefined; expires: number }>();

  constructor(private readonly ctx: ServerContext) {
    this.service = chatServiceFor(ctx);
    this.home = ctx.paths.home;
  }

  /**
   * `GET /artifact-view/<capability>`: the page of one artifact for a sandboxed iframe or a new tab. It needs no token (an
   * iframe cannot send one) and carries none: the capability names one artifact and expires. The CSP header sandboxes the
   * document itself, so even opened as a top-level page it has no access to the app's origin.
   */
  view(req: Request, capability: string): Response {
    if (!hostAllowed(req.headers.get("host"), this.ctx.bindHost, this.ctx.hostname)) {
      return jsonResponse(403, { error: "bad host" });
    }
    const grant = this.views.get(capability);
    if (grant === undefined || grant.expires < Date.now()) {
      this.views.delete(capability);
      return jsonResponse(404, { error: "expired" });
    }
    try {
      const store = this.service.artifactStore(this.service.chat(grant.chatId));
      const got = store.read(grant.name, grant.version, true);
      const kind = kindOf(grant.name);
      if (kind === "svg") {
        return new Response(got.bytes as unknown as BodyInit, {
          headers: { "Content-Type": "image/svg+xml", "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
        });
      }
      const body = kind === "html" ? got.bytes : new TextEncoder().encode(`<!doctype html><meta charset="utf-8"><title>${grant.name.replace(/[<&]/g, "")}</title><pre style="white-space:pre-wrap;font:14px/1.5 ui-monospace,monospace;margin:16px">${new TextDecoder().decode(got.bytes).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`);
      return new Response(body as unknown as BodyInit, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": VIEW_CSP, "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
      });
    } catch (err) {
      return err instanceof WorkspaceError ? jsonResponse(err.status, { error: err.message }) : jsonResponse(404, { error: "no such artifact" });
    }
  }

  @Post("/chats/{id}/artifacts/{name}/view", { summary: "A sandboxed address of an artifact", description: "Returns `/artifact-view/<capability>`, valid 30 minutes, for one artifact (the current content, or `version`). The page is served with a sandbox CSP and needs no token." })
  @Param(ArtifactParamsDto.schema)
  @Body(ArtifactViewInputDto.schema)
  @ResponseSchema(ArtifactViewDto.schema, { description: "The address." })
  issueView(c: ApiContext): Promise<Response> {
    return guarded(() => {
      const chat = this.service.chat(idOf(c));
      const { name } = valid<{ name: string }>(c, "param");
      const version = valid<{ version?: number }>(c, "json").version;
      this.service.artifactStore(chat).read(name, version, true);
      const now = Date.now();
      for (const [k, g] of this.views) {
        if (g.expires < now) {
          this.views.delete(k);
        }
      }
      const capability = randomBytes(24).toString("hex");
      this.views.set(capability, { chatId: chat.id, name, version, expires: now + VIEW_TTL_MS });
      return jsonResponse(200, { url: `/artifact-view/${capability}` });
    });
  }

  /** The store, after a scan: a file the watcher has not versioned yet is versioned (and announced) now. */
  private store(c: ApiContext) {
    const chat = this.service.chat(idOf(c));
    const store = this.service.artifactStore(chat);
    for (const ev of store.scan(chat.id, null)) {
      this.service.emitArtifact(ev);
    }
    return store;
  }

  @Get("/chats/{id}/artifacts", { summary: "The artifacts of a chat", description: "Files of `<workspace>/artifacts/`, newest first, with the current version number and content hash." })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(ArtifactListDto.schema, { description: "The artifacts." })
  list(c: ApiContext): Promise<Response> {
    return guarded(() => jsonResponse(200, { items: this.store(c).list() }));
  }

  @Get("/chats/{id}/artifacts/{name}/versions", { summary: "Versions of an artifact", description: "Every snapshot: number, time, turn id and author (agent, user or restore)." })
  @Param(ArtifactParamsDto.schema)
  @ResponseSchema(ArtifactVersionsDto.schema, { description: "The versions." })
  versions(c: ApiContext): Promise<Response> {
    return guarded(() => {
      const store = this.store(c);
      const { name } = valid<{ name: string }>(c, "param");
      store.info(name);
      return jsonResponse(200, { items: store.versions(name) });
    });
  }

  @Get("/chats/{id}/artifacts/{name}/content", { summary: "Read an artifact", description: "The bytes of the current file or of a version. Text is `text/plain`, images keep their type, everything else downloads. The response carries a sandbox CSP and nosniff. `preview=1` refuses more than 5 MB." })
  @Param(ArtifactParamsDto.schema)
  @Query(ArtifactContentQueryDto.schema)
  @ResponseSchema(ErrorDto.schema, { status: 413, description: "Above the preview limit." })
  content(c: ApiContext): Promise<Response> {
    return guarded(() => {
      const { name } = valid<{ name: string }>(c, "param");
      const q = valid<{ version?: number; download?: string; preview?: string }>(c, "query");
      const got = this.store(c).read(name, q.version, q.preview === "1");
      const kind = kindOf(name);
      const mime = detectMime(got.bytes, name);
      const inlineType = kind === "image" || kind === "svg" ? (mime.startsWith("image/") ? mime : null) : kind === "pdf" ? "application/pdf" : kind === "unknown" ? null : "text/plain; charset=utf-8";
      const inline = q.download !== "1" && inlineType !== null;
      return new Response(got.bytes as unknown as BodyInit, {
        headers: {
          "Content-Type": inline ? (inlineType as string) : "application/octet-stream",
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
          "Content-Security-Policy": "sandbox; default-src 'none'",
          "X-Content-Type-Options": "nosniff",
          "X-Artifact-Version": String(got.version),
          "X-Artifact-Hash": got.hash,
          "Cache-Control": "no-store",
        },
      });
    });
  }

  @Put("/chats/{id}/artifacts/{name}", { summary: "Save an edit of an artifact", description: "Writes the file and records a version authored by the user. The next turn gets a note that the user changed it. 413 above 5 MB, 409 when `base_hash` no longer matches." })
  @Param(ArtifactParamsDto.schema)
  @Body(ArtifactWriteDto.schema)
  @ResponseSchema(ArtifactSavedDto.schema, { description: "Saved." })
  @ResponseSchema(ErrorDto.schema, { status: 409, description: "The artifact changed meanwhile." })
  save(c: ApiContext): Promise<Response> {
    return guarded(() => {
      const chat = this.service.chat(idOf(c));
      const store = this.service.artifactStore(chat);
      const { name } = valid<{ name: string }>(c, "param");
      const body = valid<{ content: string; base_hash?: string }>(c, "json");
      const bytes = new TextEncoder().encode(body.content);
      if (bytes.length > PREVIEW_LIMIT) {
        throw new WorkspaceError(413, "the artifact is larger than 5 MB");
      }
      const version = store.write(name, bytes, "user", body.base_hash);
      return this.saved(chat.id, store, name, version);
    });
  }

  @Post("/chats/{id}/artifacts/{name}/restore", { summary: "Restore a version", description: "Writes the old content back as a new version; no version is removed." })
  @Param(ArtifactParamsDto.schema)
  @Body(ArtifactRestoreDto.schema)
  @ResponseSchema(ArtifactSavedDto.schema, { description: "Restored." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such version." })
  restore(c: ApiContext): Promise<Response> {
    return guarded(() => {
      const chat = this.service.chat(idOf(c));
      const store = this.service.artifactStore(chat);
      const { name } = valid<{ name: string }>(c, "param");
      const version = store.restore(name, valid<{ version: number }>(c, "json").version);
      return this.saved(chat.id, store, name, version);
    });
  }

  private saved(chatId: string, store: ReturnType<ChatService["artifactStore"]>, name: string, version: ReturnType<typeof store.restore>): Response {
    const artifact = store.info(name);
    if (version !== null) {
      this.service.emitArtifact({ chat_id: chatId, name, change: "updated", version: version.n, kind: artifact.kind, hash: version.hash, turn: null });
    }
    return jsonResponse(200, { artifact, version });
  }

  @Get("/artifact-settings", { summary: "Artifact settings", description: "Whether Write and Edit tool calls of files outside `artifacts/` become artifacts, and the opted-in extensions." })
  @ResponseSchema(ArtifactSettingsDto.schema, { description: "The settings." })
  settings(): Promise<Response> {
    return guarded(() => jsonResponse(200, readSettings(this.home)));
  }

  @Put("/artifact-settings", { summary: "Change artifact settings", description: "Replaces the settings." })
  @Body(ArtifactSettingsDto.schema)
  @ResponseSchema(ArtifactSettingsDto.schema, { description: "Saved." })
  saveSettings(c: ApiContext): Promise<Response> {
    return guarded(() => jsonResponse(200, writeSettings(this.home, valid<{ track_external: boolean; extensions: string[] }>(c, "json"))));
  }
}
