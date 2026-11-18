import { Controller, Get, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { SkillsListDto } from "../../../shared/dto/skills";
import { jsonResponse } from "../../http/responses";
import { scanSkills } from "../../skills/scan-skills";
import type { ApiContext } from "../pipeline";

@Controller({ path: "/api", tags: ["skills"] })
export class SkillsController {
  @Get("/skills", {
    summary: "Skills for the composer",
    description: "Lists the skills the server can read (name and description from SKILL.md front matter), for the slash menu.",
  })
  @ResponseSchema(SkillsListDto.schema, { description: "The skills, sorted by name." })
  async list(_c: ApiContext): Promise<Response> {
    return jsonResponse(200, { skills: await scanSkills() });
  }
}
