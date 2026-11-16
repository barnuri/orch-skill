import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

const kind = z.enum(["html", "markdown", "svg", "image", "mermaid", "csv", "json", "pdf", "tsx", "code", "text", "unknown"]);
export const artifactInfoSchema = z.object({ name: z.string(), kind, size: z.number(), modified: z.string(), version: z.number(), hash: z.string() });
export const artifactVersionSchema = z.object({ n: z.number(), at: z.string(), turn: z.string().nullable(), author: z.enum(["agent", "user", "restore"]), hash: z.string(), size: z.number() });
export const artifactSettingsSchema = z.object({ track_external: z.boolean(), extensions: z.array(z.string().max(8)).max(40) });

@ZodObject({ description: "One artifact of a chat." })
export class ArtifactParamsDto extends ZodDto {
  @ZodField(z.string().min(1).max(100), { description: "Chat id." })
  id!: string;

  @ZodField(z.string().min(1).max(255), { description: "Bare artifact file name, URL-encoded." })
  name!: string;
}

@ZodObject({ description: "Which version to read, and how." })
export class ArtifactContentQueryDto extends ZodDto {
  @ZodField(z.coerce.number().int().min(1).optional(), { description: "A version number; the current file when omitted." })
  version?: number;

  @ZodField(z.enum(["0", "1"]).optional(), { description: "1 to send as a download." })
  download?: "0" | "1";

  @ZodField(z.enum(["0", "1"]).optional(), { description: "1 to refuse files above the 5 MB preview limit (413)." })
  preview?: "0" | "1";
}

@ZodObject({ description: "The artifacts of a chat." })
export class ArtifactListDto extends ZodDto {
  @ZodField(z.array(artifactInfoSchema), { description: "Artifacts, newest first." })
  items!: z.infer<typeof artifactInfoSchema>[];

  @ZodField(z.string(), { description: "Absolute path of the artifacts folder (the agent edits files there)." })
  dir!: string;
}

@ZodObject({ description: "The versions of an artifact, oldest first." })
export class ArtifactVersionsDto extends ZodDto {
  @ZodField(z.array(artifactVersionSchema), { description: "Versions." })
  items!: z.infer<typeof artifactVersionSchema>[];
}

@ZodObject({ description: "A user edit of an artifact." })
export class ArtifactWriteDto extends ZodDto {
  @ZodField(z.string().min(1).max(5 * 1024 * 1024), { description: "The new content." })
  content!: string;

  @ZodField(z.string().max(40).optional(), { description: "Hash of the content the editor started from; a different current hash answers 409." })
  base_hash?: string;
}

@ZodObject({ description: "Restore a version as a new version." })
export class ArtifactRestoreDto extends ZodDto {
  @ZodField(z.number().int().min(1), { description: "The version to restore." })
  version!: number;
}

@ZodObject({ description: "A saved artifact." })
export class ArtifactSavedDto extends ZodDto {
  @ZodField(artifactInfoSchema, { description: "The artifact now." })
  artifact!: z.infer<typeof artifactInfoSchema>;

  @ZodField(artifactVersionSchema.nullable(), { description: "The new version, or null when the content did not change." })
  version!: z.infer<typeof artifactVersionSchema> | null;
}

@ZodObject({ description: "Artifact settings." })
export class ArtifactSettingsDto extends ZodDto {
  @ZodField(z.boolean(), { description: "Track files an agent writes elsewhere under the chat folder." })
  track_external!: boolean;

  @ZodField(z.array(z.string().max(8)).max(40), { description: "Extensions (no dot) tracked for those files." })
  extensions!: string[];
}

@ZodObject({ description: "Which version a sandboxed address shows." })
export class ArtifactViewInputDto extends ZodDto {
  @ZodField(z.number().int().min(1).optional(), { description: "A version number; the current content when omitted." })
  version?: number;
}

@ZodObject({ description: "A sandboxed address of an artifact." })
export class ArtifactViewDto extends ZodDto {
  @ZodField(z.string(), { description: "Path of the page, `/artifact-view/<capability>`." })
  url!: string;
}
