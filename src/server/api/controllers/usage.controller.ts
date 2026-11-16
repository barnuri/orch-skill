import { Body, Controller, Param, Patch, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { ErrorDto } from "../../../shared/dto/common";
import { UsageInputDto, UsageParamsDto, UsageResultDto } from "../../../shared/dto/usage";
import { setUsage } from "../../routes/usage-routes";
import type { ServerContext } from "../../types/server-context";
import type { ApiContext } from "../pipeline";
import { valid } from "./support";

@Controller({ path: "/api", tags: ["profiles", "harnesses"] })
export class UsageController {
  constructor(private readonly ctx: ServerContext) {}

  @Patch("/profiles/{id}/usage", {
    summary: "Limit a profile to chat, orch runs or both",
    description: "Runs `dispatch.ts profile set-usage`. A profile is available for a use only when its harness allows it too. A chat already on the profile keeps working.",
  })
  @Param(UsageParamsDto.schema)
  @Body(UsageInputDto.schema)
  @ResponseSchema(UsageResultDto.schema, { description: "The stored usage." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such profile." })
  profile(c: ApiContext): Promise<Response> {
    return setUsage(this.ctx, "profile", valid<{ id: string }>(c, "param").id, valid<{ usage: "chat" | "runs" | "both" }>(c, "json").usage);
  }

  @Patch("/harnesses/{id}/usage", {
    summary: "Limit a harness to chat, orch runs or both",
    description: "Runs `dispatch.ts harness set-usage`. Every profile of the harness follows it.",
  })
  @Param(UsageParamsDto.schema)
  @Body(UsageInputDto.schema)
  @ResponseSchema(UsageResultDto.schema, { description: "The stored usage." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such harness." })
  harness(c: ApiContext): Promise<Response> {
    return setUsage(this.ctx, "harness", valid<{ id: string }>(c, "param").id, valid<{ usage: "chat" | "runs" | "both" }>(c, "json").usage);
  }
}
