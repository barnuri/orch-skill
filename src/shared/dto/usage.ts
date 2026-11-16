import { z } from "zod";
import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";

import { USAGE_CHOICES, USAGE_VALUES } from "../profile-usage";

@ZodObject({ description: "The profile or harness to change." })
export class UsageParamsDto extends ZodDto {
  @ZodField(z.string().min(1).max(64), { description: "Profile name or harness id." })
  id!: string;
}

@ZodObject({ description: "Where a profile or harness may be used." })
export class UsageInputDto extends ZodDto {
  @ZodField(z.enum(USAGE_CHOICES as unknown as [string, ...string[]]), { description: "`chat` (chat page only), `runs` (orch runs, nodes, loops, schedules, planner only) or `both`." })
  usage!: "chat" | "runs" | "both";
}

@ZodObject({ description: "The usage after the change." })
export class UsageResultDto extends ZodDto {
  @ZodField(z.string(), { description: "Profile name or harness id." })
  id!: string;

  @ZodField(z.array(z.enum(USAGE_VALUES)), { description: "The stored own usage: `chat` and/or `runs`." })
  usage!: Array<"chat" | "runs">;
}
