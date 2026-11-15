import { Controller, Get, Post, Put, Response as ResponseSchema } from "@barnuri/hono-decorators";

import type { RouteHandler } from "../../http/route";
import { getDocumentHandler, putDocumentHandler } from "../../routes/document-routes";
import { listHarnessesHandler } from "../../routes/harnesses-routes";
import { profileSanityHandler } from "../../routes/profiles-routes";
import type { ServerContext } from "../../types/server-context";
import { ErrorDto } from "../dto/common";
import { OpaqueDocumentDto } from "../dto/common";
import { HarnessesEnvelopeDto } from "../dto/runs";
import type { ApiContext } from "../pipeline";
import { call } from "./support";

// PUT bodies are read raw on purpose: the handler enforces the 1 MiB limit with a descriptive 413 and
// parses with the strict JSON reader, and both need the unread request body.
@Controller({ path: "/api", tags: ["documents"] })
export class DocumentsController {
  private readonly getProfiles: RouteHandler;
  private readonly putProfiles: RouteHandler;
  private readonly getMemory: RouteHandler;
  private readonly putMemory: RouteHandler;
  private readonly sanity: RouteHandler;

  constructor(ctx: ServerContext) {
    this.getProfiles = getDocumentHandler(ctx, "profiles");
    this.putProfiles = putDocumentHandler(ctx, "profiles");
    this.getMemory = getDocumentHandler(ctx, "memory");
    this.putMemory = putDocumentHandler(ctx, "memory");
    this.sanity = profileSanityHandler(ctx);
  }

  @Get("/profiles", {
    summary: "Read profiles.json",
    description: "The profiles document with its validation issues, the allowed enum values and the body limit. The ETag is the optimistic-concurrency token for PUT.",
  })
  @ResponseSchema(OpaqueDocumentDto.schema, { description: "The document, its issues and limits." })
  getProfiles_(c: ApiContext): Promise<Response> {
    return call(this.getProfiles, c);
  }

  @Put("/profiles", {
    summary: "Replace profiles.json",
    description: "Replaces the whole profiles document. Send the ETag from GET in `If-Match`: a stale one answers 412. A body over 1 MiB answers 413, a document that fails validation 422 with every issue and its path.",
  })
  @ResponseSchema(OpaqueDocumentDto.schema, { description: "Saved; the new ETag is in the header." })
  @ResponseSchema(ErrorDto.schema, { status: 412, description: "The file changed since you read it." })
  @ResponseSchema(ErrorDto.schema, { status: 422, description: "The document is invalid." })
  putProfiles_(c: ApiContext): Promise<Response> {
    return call(this.putProfiles, c);
  }

  @Post("/profiles/sanity", {
    summary: "Sanity-test profiles",
    description: "Runs one real harness call per profile and reports ok, failed, disabled or unconfigured with timing. Slow: it can take tens of seconds, so the connection stays open for up to 4 minutes. A profile that is switched off, or whose harness is, is reported disabled without running.",
  })
  @ResponseSchema(OpaqueDocumentDto.schema, { description: "One result per profile." })
  sanity_(c: ApiContext): Promise<Response> {
    return call(this.sanity, c);
  }

  @Get("/memory", {
    summary: "Read memory.json",
    description: "The routing memory: outcomes orch learned and uses to pick a profile.",
  })
  @ResponseSchema(OpaqueDocumentDto.schema, { description: "The document, its issues and limits." })
  getMemory_(c: ApiContext): Promise<Response> {
    return call(this.getMemory, c);
  }

  @Put("/memory", {
    summary: "Replace memory.json",
    description: "Replaces the whole memory document, with the same `If-Match`, 413 and 422 rules as profiles.",
  })
  @ResponseSchema(OpaqueDocumentDto.schema, { description: "Saved." })
  @ResponseSchema(ErrorDto.schema, { status: 412, description: "The file changed since you read it." })
  putMemory_(c: ApiContext): Promise<Response> {
    return call(this.putMemory, c);
  }
}

@Controller({ path: "/api", tags: ["harnesses"] })
export class HarnessesController {
  private readonly list: RouteHandler;

  constructor(ctx: ServerContext) {
    this.list = listHarnessesHandler(ctx);
    // Probed once now, in the background, so the first visit to the Harnesses page finds it cached.
    void Promise.resolve(this.list(new Request("http://localhost/api/harnesses"), {})).catch(() => undefined);
  }

  @Get("/harnesses", {
    summary: "Harnesses on this machine",
    description: "Every harness orch knows of: whether it is wired, enabled, and found on this machine. The probe is cached for 20 s and shared between callers; a change to profiles.json invalidates it at once, and `?refresh=1` forces a new probe.",
  })
  @ResponseSchema(HarnessesEnvelopeDto.schema, { description: "The harnesses." })
  list_(c: ApiContext): Promise<Response> {
    return call(this.list, c);
  }
}
