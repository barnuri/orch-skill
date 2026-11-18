import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

@ZodObject({ description: "One skill the server can read." })
export class SkillDto extends ZodDto {
  @ZodField(z.string(), { description: "Skill name from the SKILL.md front matter." })
  name!: string;

  @ZodField(z.string(), { description: "Skill description from the front matter." })
  description!: string;
}

@ZodObject({ description: "The skills list." })
export class SkillsListDto extends ZodDto {
  @ZodField([SkillDto], { description: "The skills, sorted by name." })
  skills!: SkillDto[];
}
