import { Controller, Get, Param, Post, Put, Response as ResponseSchema } from "@barnuri/hono-decorators";

import type { RouteHandler } from "../../http/route";
import {
  applySuggestionHandler,
  bulkApplySuggestionsHandler,
  dismissSuggestionHandler,
  getSuggestionsHandler,
  putSuggestionsHandler,
  scanSuggestionsHandler,
} from "../../routes/suggestions-routes";
import type { ServerContext } from "../../types/server-context";
import { ErrorDto, OkDto, OpaqueDocumentDto } from "../dto/common";
import { SuggestionIdParamsDto } from "../dto/runs";
import type { ApiContext } from "../pipeline";
import { call } from "./support";

@Controller({ path: "/api", tags: ["suggestions"] })
export class SuggestionsController {
  private readonly get_: RouteHandler;
  private readonly put_: RouteHandler;
  private readonly scan_: RouteHandler;
  private readonly applyAll_: RouteHandler;
  private readonly apply_: RouteHandler;
  private readonly dismiss_: RouteHandler;

  constructor(ctx: ServerContext) {
    this.get_ = getSuggestionsHandler(ctx);
    this.put_ = putSuggestionsHandler(ctx);
    this.scan_ = scanSuggestionsHandler(ctx);
    this.applyAll_ = bulkApplySuggestionsHandler(ctx);
    this.apply_ = applySuggestionHandler(ctx);
    this.dismiss_ = dismissSuggestionHandler(ctx);
  }

  @Get("/suggestions", {
    summary: "Read suggestions.json",
    description: "Profile and routing changes orch proposes from what it has learned, each with its evidence.",
  })
  @ResponseSchema(OpaqueDocumentDto.schema, { description: "The document, its issues and limits." })
  get(c: ApiContext): Promise<Response> {
    return call(this.get_, c);
  }

  @Put("/suggestions", {
    summary: "Replace suggestions.json",
    description: "Replaces the whole suggestions document, with the same `If-Match`, 413 and 422 rules as profiles.",
  })
  @ResponseSchema(OpaqueDocumentDto.schema, { description: "Saved." })
  put(c: ApiContext): Promise<Response> {
    return call(this.put_, c);
  }

  @Post("/suggestions/scan", {
    summary: "Scan for new suggestions",
    description: "Looks through memory for changes worth proposing and adds them to suggestions.json.",
  })
  @ResponseSchema(OkDto.schema, { description: "Scanned." })
  scan(c: ApiContext): Promise<Response> {
    return call(this.scan_, c);
  }

  @Post("/suggestions/apply", {
    summary: "Apply suggestions in bulk",
    description: "Applies the listed suggestion ids, or every safe one with `{\"all\": true}`.",
  })
  @ResponseSchema(OkDto.schema, { description: "Applied." })
  applyAll(c: ApiContext): Promise<Response> {
    return call(this.applyAll_, c);
  }

  @Post("/suggestions/{id}/apply", {
    summary: "Apply one suggestion",
    description: "Applies a single suggestion to profiles.json and marks it applied.",
  })
  @Param(SuggestionIdParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Applied." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such suggestion." })
  apply(c: ApiContext): Promise<Response> {
    return call(this.apply_, c);
  }

  @Post("/suggestions/{id}/dismiss", {
    summary: "Dismiss one suggestion",
    description: "Hides a suggestion for the dismissal window.",
  })
  @Param(SuggestionIdParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Dismissed." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such suggestion." })
  dismiss(c: ApiContext): Promise<Response> {
    return call(this.dismiss_, c);
  }
}
