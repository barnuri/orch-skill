import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

const SCOPE = z.enum(["chat", "folder"]);
const AREA = z.enum(["knowledge", "artifacts"]);

export const workspaceFileSchema = z.object({
  name: z.string(),
  size: z.number(),
  modified: z.string(),
  type: z.string(),
  preview: z.enum(["image", "text", "none"]),
});

@ZodObject({ description: "Which workspace of a chat: its own, or the one every chat of its folder shares." })
export class WorkspaceScopeQueryDto extends ZodDto {
  @ZodField(SCOPE.optional(), { description: "`chat` (default) or `folder`. `folder` is refused (400) when the chat has no folder." })
  scope?: "chat" | "folder";

  @ZodField(z.enum(["0", "1"]).optional(), { description: "1 to send a file as a download instead of showing it inline." })
  download?: "0" | "1";
}

@ZodObject({ description: "A file of a workspace area." })
export class WorkspaceFileParamsDto extends ZodDto {
  @ZodField(z.string().min(1).max(100), { description: "Chat id." })
  id!: string;

  @ZodField(AREA, { description: "`knowledge` or `artifacts`." })
  area!: "knowledge" | "artifacts";

  @ZodField(z.string().min(1).max(255), { description: "Bare file name, URL-encoded." })
  name!: string;
}

@ZodObject({ description: "An area of a workspace." })
export class WorkspaceAreaParamsDto extends ZodDto {
  @ZodField(z.string().min(1).max(100), { description: "Chat id." })
  id!: string;

  @ZodField(AREA, { description: "`knowledge` or `artifacts`." })
  area!: "knowledge" | "artifacts";
}

@ZodObject({ description: "A workspace: where it is and what it holds." })
export class WorkspaceDto extends ZodDto {
  @ZodField(SCOPE, { description: "Which workspace." })
  scope!: "chat" | "folder";

  @ZodField(z.string(), { description: "Absolute path of the workspace directory (created on first use)." })
  path!: string;

  @ZodField(z.boolean(), { description: "Whether the directory exists yet." })
  exists!: boolean;

  @ZodField(z.boolean(), { description: "Whether the chat has a folder, so the folder scope exists." })
  has_folder!: boolean;

  @ZodField(z.string().nullable(), { description: "Where this chat's earlier workspace stayed after the chat moved, or null." })
  moved_from!: string | null;

  @ZodField(z.number(), { description: "Size of MEMORY.md in bytes (0 when missing)." })
  memory_size!: number;

  @ZodField(z.object({ knowledge: z.array(workspaceFileSchema), artifacts: z.array(workspaceFileSchema) }), { description: "Files per area, newest first." })
  files!: { knowledge: z.infer<typeof workspaceFileSchema>[]; artifacts: z.infer<typeof workspaceFileSchema>[] };
}

@ZodObject({ description: "MEMORY.md of a workspace." })
export class WorkspaceMemoryDto extends ZodDto {
  @ZodField(z.string(), { description: "The markdown text (empty when the file does not exist)." })
  content!: string;

  @ZodField(z.boolean(), { description: "Whether the file exists." })
  exists!: boolean;

  @ZodField(z.string().nullable(), { description: "Last change, ISO time, or null." })
  modified!: string | null;
}

@ZodObject({ description: "New text for MEMORY.md." })
export class WorkspaceMemoryInputDto extends ZodDto {
  @ZodField(z.string().max(400_000), { description: "The whole file. Larger than 200 KB answers 413." })
  content!: string;
}

@ZodObject({ description: "Files stored by an upload." })
export class WorkspaceFilesDto extends ZodDto {
  @ZodField(z.array(workspaceFileSchema), { description: "The stored files." })
  items!: z.infer<typeof workspaceFileSchema>[];
}
