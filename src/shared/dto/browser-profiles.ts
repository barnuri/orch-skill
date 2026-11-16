import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

export const browserProfileSchema = z.object({
  path: z.string(),
  size_bytes: z.number(),
  last_used: z.string().nullable(),
  chats: z.array(z.string()),
  in_use: z.boolean(),
});

@ZodObject({ description: "The persistent Playwright browser profiles the dashboard knows." })
export class BrowserProfilesDto extends ZodDto {
  @ZodField(z.array(browserProfileSchema), { description: "Path, size, last use, ids of the chats that used it, and whether a running chat holds it now. File contents are never read." })
  profiles!: Array<z.infer<typeof browserProfileSchema>>;
}

@ZodObject({ description: "The profile to forget." })
export class BrowserProfileForgetDto extends ZodDto {
  @ZodField(z.string().min(1).max(4096), { description: "Absolute path of a listed profile. Anything not listed, or outside `<folder>/.orch/browser/` and `<home>/browser/`, is refused." })
  path!: string;
}

@ZodObject({ description: "A profile moved to the trash." })
export class BrowserProfileForgottenDto extends ZodDto {
  @ZodField(z.boolean(), { description: "Always true." })
  ok!: boolean;

  @ZodField(z.string(), { description: "Where the folder is now (a `.trash` folder next to it); nothing is deleted." })
  trashed_to!: string;
}
