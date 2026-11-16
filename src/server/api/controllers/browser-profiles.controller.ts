import { Body, Controller, Get, Post, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { BrowserProfileForgetDto, BrowserProfileForgottenDto, BrowserProfilesDto } from "../../../shared/dto/browser-profiles";
import { ErrorDto } from "../../../shared/dto/common";
import { BrowserProfileError, forgetProfile, listProfiles } from "../../chats/browser-profile";
import { jsonResponse } from "../../http/responses";
import type { ServerContext } from "../../types/server-context";
import type { ApiContext } from "../pipeline";
import { valid } from "./support";

@Controller({ path: "/api", tags: ["browser-profiles"] })
export class BrowserProfilesController {
  constructor(private readonly ctx: ServerContext) {}

  @Get("/browser-profiles", {
    summary: "List the persistent browser profiles",
    description: "Profiles hold logins: only metadata is returned (path, size, last use, chats, in use). Cookie files are never read.",
  })
  @ResponseSchema(BrowserProfilesDto.schema, { description: "The known profiles, most recently used first." })
  list(): Response {
    return jsonResponse(200, { profiles: listProfiles(this.ctx.paths.home) });
  }

  @Post("/browser-profiles/forget", {
    summary: "Forget the logins of a profile",
    description: "Moves the profile folder into a `.trash` folder next to it. 404 for an unknown path, 400 for a path outside the profile folders, 409 while a running chat holds it.",
  })
  @Body(BrowserProfileForgetDto.schema)
  @ResponseSchema(BrowserProfileForgottenDto.schema, { description: "Moved to the trash." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Path outside the known folders." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "Unknown profile." })
  @ResponseSchema(ErrorDto.schema, { status: 409, description: "In use." })
  forget(c: ApiContext): Response {
    try {
      return jsonResponse(200, { ok: true, trashed_to: forgetProfile(this.ctx.paths.home, valid<{ path: string }>(c, "json").path) });
    } catch (err) {
      if (err instanceof BrowserProfileError) {
        return jsonResponse(err.status, { error: err.message });
      }
      return jsonResponse(500, { error: "could not forget the profile" });
    }
  }
}
