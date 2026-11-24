import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

@ZodObject({ description: "A commit the running server does not include." })
export class BuildCommitDto extends ZodDto {
  @ZodField(z.string(), { description: "Full commit sha." })
  sha!: string;

  @ZodField(z.string(), { description: "First line of the commit message." })
  subject!: string;

  @ZodField(z.string(), { description: "Commit date, ISO 8601." })
  date!: string;
}

@ZodObject({ description: "A source file changed after the server started." })
export class BuildFileDto extends ZodDto {
  @ZodField(z.string(), { description: "Path relative to the repository root." })
  path!: string;

  @ZodField(z.string(), { description: "Modification time, ISO 8601." })
  mtime!: string;
}

@ZodObject({ description: "Files changed after the server started." })
export class BuildChangedFilesDto extends ZodDto {
  @ZodField(z.number().int(), { description: "How many files are newer than the boot time." })
  count!: number;

  @ZodField([BuildFileDto], { description: "The newest 8." })
  newest!: BuildFileDto[];
}

@ZodObject({ description: "Uncommitted changes in the checkout." })
export class BuildUncommittedDto extends ZodDto {
  @ZodField(z.number().int(), { description: "Paths in `git status --porcelain`." })
  count!: number;
}

@ZodObject({ description: "Work a restart would interrupt." })
export class BuildBusyDto extends ZodDto {
  @ZodField(z.number().int(), { description: "Chats with a reply streaming now. A restart cuts them." })
  chats_streaming!: number;

  @ZodField(z.number().int(), { description: "Orch run nodes running now. A restart does not affect them; agents run outside the server." })
  runs_running!: number;
}

@ZodObject({ description: "The last deploy through scripts/deploy.ts." })
export class DeployInfoDto extends ZodDto {
  @ZodField(z.string().nullable(), { description: "Deployed sha." })
  sha!: string | null;

  @ZodField(z.string().nullable(), { description: "Deployed short sha." })
  short!: string | null;

  @ZodField(z.string().nullable(), { description: "Deployed ref." })
  ref!: string | null;

  @ZodField(z.string().nullable(), { description: "When, ISO 8601." })
  deployed_at!: string | null;

  @ZodField(z.number().int().nullable(), { description: "Commits master is ahead of the deployed sha." })
  behind!: number | null;

  @ZodField(z.string().nullable(), { description: "Reason of the last deploy, when it failed." })
  failed!: string | null;
}

@ZodObject({ description: "Whether the running server includes the code on disk." })
export class BuildInfoDto extends ZodDto {
  @ZodField(DeployInfoDto.schema.nullable(), { description: "Deploy state; null when never deployed." })
  deploy!: DeployInfoDto | null;

  @ZodField(z.string(), { description: "When this server process started, ISO 8601 UTC." })
  boot_at!: string;

  @ZodField(z.string().nullable(), { description: "Git HEAD at startup; null when git was unavailable." })
  boot_head!: string | null;

  @ZodField(z.string().nullable(), { description: "Git HEAD now." })
  head!: string | null;

  @ZodField(z.string().nullable(), { description: "Current branch." })
  branch!: string | null;

  @ZodField(z.boolean(), { description: "HEAD moved since startup, or a source file is newer than the boot time. False when the check failed." })
  stale!: boolean;

  @ZodField(z.array(z.enum(["commits", "files"])), { description: "Why it is stale." })
  reasons!: ("commits" | "files")[];

  @ZodField([BuildCommitDto], { description: "git log boot_head..HEAD, newest first, at most 20." })
  missing_commits!: BuildCommitDto[];

  @ZodField(z.number().int(), { description: "How many commits boot_head..HEAD holds in all." })
  missing_total!: number;

  @ZodField(BuildChangedFilesDto.schema, { description: "Source files newer than the boot time." })
  changed_files!: BuildChangedFilesDto;

  @ZodField(BuildUncommittedDto.schema, { description: "Uncommitted changes." })
  uncommitted!: BuildUncommittedDto;

  @ZodField(BuildBusyDto.schema, { description: "What a restart would interrupt." })
  busy!: BuildBusyDto;

  @ZodField(z.string().nullable(), { description: "Why the check failed, when it did; the dashboard then says the check is unavailable." })
  error!: string | null;
}

@ZodObject({ description: "A restart was scheduled." })
export class RestartAcceptedDto extends ZodDto {
  @ZodField(z.boolean(), { description: "Always true." })
  ok!: boolean;

  @ZodField(z.number().int(), { description: "Milliseconds until the restart starts." })
  restart_in_ms!: number;
}

@ZodObject({ description: "A restart that was refused, with the command to run by hand." })
export class RestartRefusedDto extends ZodDto {
  @ZodField(z.string(), { description: "Why." })
  error!: string;

  @ZodField(z.string(), { description: "What to run instead." })
  command!: string;
}
