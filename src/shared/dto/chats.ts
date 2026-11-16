import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

const ROLE = z.enum(["user", "assistant", "system", "tool"]);
const MESSAGE_STATUS = z.enum(["pending", "streaming", "done", "error", "stopped"]);
const CHAT_STATUS = z.enum(["idle", "running"]);
const LIMIT = z.coerce.number().int().min(1).max(100).optional();
const FLAG = z.enum(["0", "1", "true", "false"]).optional();

// ---- shared params and queries ----

@ZodObject({ description: "Which project, chat or attachment." })
export class ChatIdParamsDto extends ZodDto {
  @ZodField(z.string().min(1).max(100), { description: "Id: `prj-…`, `chat-…` or `att-…`, time-sortable." })
  id!: string;
}

@ZodObject({ description: "Paging. Pages hold 30 items unless `limit` says otherwise (1 to 100)." })
export class PageQueryDto extends ZodDto {
  @ZodField(LIMIT, { description: "Items per page, 1 to 100. Default 30." })
  limit?: number;

  @ZodField(z.string().max(200).optional(), { description: "`next_cursor` of the previous page. Opaque." })
  cursor?: string;
}

@ZodObject({ description: "Paging for the project list." })
export class ProjectsQueryDto extends ZodDto {
  @ZodField(LIMIT, { description: "Items per page, 1 to 100. Default 30." })
  limit?: number;

  @ZodField(z.string().max(200).optional(), { description: "`next_cursor` of the previous page. Opaque." })
  cursor?: string;

  @ZodField(FLAG, { description: "1 to include archived projects. Default 0." })
  archived?: string;
}

@ZodObject({ description: "Filters and paging for the chat list. Newest activity first." })
export class ChatsQueryDto extends ZodDto {
  @ZodField(LIMIT, { description: "Items per page, 1 to 100. Default 30." })
  limit?: number;

  @ZodField(z.string().max(200).optional(), { description: "`next_cursor` of the previous page. Opaque." })
  cursor?: string;

  @ZodField(z.string().max(100).optional(), { description: "Only chats of this project. `none` lists chats without a project." })
  project_id?: string;

  @ZodField(FLAG, { description: "1 lists archived chats instead of active ones. Default 0." })
  archived?: string;
}

@ZodObject({ description: "Search words." })
export class ChatSearchQueryDto extends ZodDto {
  @ZodField(z.string().min(1).max(200), { description: "Words to find in message text. Every word must match; the last one matches as a prefix." })
  q!: string;

  @ZodField(z.string().max(100).optional(), { description: "Only search chats of this project." })
  project_id?: string;

  @ZodField(LIMIT, { description: "Hits to return, 1 to 100. Default 30." })
  limit?: number;
}

// ---- projects ----

@ZodObject({ description: "A project groups chats and gives them a working directory." })
export class ProjectDto extends ZodDto {
  @ZodField(z.string(), { description: "Id, `prj-…`." })
  id!: string;

  @ZodField(z.string(), { description: "Display name." })
  name!: string;

  @ZodField(z.string().nullable(), { description: "Absolute directory the project's chats run in. Null uses a scratch directory." })
  path!: string | null;

  @ZodField(z.string(), { description: "Free text." })
  description!: string;

  @ZodField(z.string(), { description: "ISO 8601 UTC." })
  created_at!: string;

  @ZodField(z.string().nullable(), { description: "When it was archived. Null while active. Projects are never deleted." })
  archived_at!: string | null;
}

@ZodObject({ description: "A page of projects, newest first." })
export class ProjectPageDto extends ZodDto {
  @ZodField(z.array(ProjectDto.schema), { description: "The projects." })
  items!: ProjectDto[];

  @ZodField(z.string().nullable(), { description: "Pass as `cursor` for the next page. Null on the last page." })
  next_cursor!: string | null;
}

@ZodObject({ description: "A new project." })
export class ProjectInputDto extends ZodDto {
  @ZodField(z.string().trim().min(1).max(200), { description: "Display name." })
  name!: string;

  @ZodField(z.string().max(1000).nullable().optional(), { description: "Absolute directory the chats run in. Must exist." })
  path?: string | null;

  @ZodField(z.string().max(5000).optional(), { description: "Free text." })
  description?: string;
}

@ZodObject({ description: "Fields of a project to change. Omitted fields stay as they are." })
export class ProjectUpdateDto extends ZodDto {
  @ZodField(z.string().trim().min(1).max(200).optional(), { description: "Display name." })
  name?: string;

  @ZodField(z.string().max(1000).nullable().optional(), { description: "Absolute directory, or null to clear it." })
  path?: string | null;

  @ZodField(z.string().max(5000).optional(), { description: "Free text." })
  description?: string;
}

// ---- chats ----

@ZodObject({ description: "A chat with one agent. Its harness, profile and model are fixed once it has a message." })
export class ChatDto extends ZodDto {
  @ZodField(z.string(), { description: "Id, `chat-…`." })
  id!: string;

  @ZodField(z.string().nullable(), { description: "Project the chat belongs to, if any." })
  project_id!: string | null;

  @ZodField(z.string(), { description: "Title. Starts as `New chat`, then the first message, until renamed." })
  title!: string;

  @ZodField(z.string(), { description: "Harness id, e.g. `claude`." })
  harness!: string;

  @ZodField(z.string(), { description: "Profile name from profiles.json." })
  profile!: string;

  @ZodField(z.string().nullable(), { description: "Catalog model id. Null means the profile's default model." })
  model_id!: string | null;

  @ZodField(z.string().nullable(), { description: "The agent's own session id, set after the first reply." })
  session_id!: string | null;

  @ZodField(CHAT_STATUS, { description: "running while a reply streams." })
  status!: "idle" | "running";

  @ZodField(z.string(), { description: "ISO 8601 UTC." })
  created_at!: string;

  @ZodField(z.string(), { description: "Last activity, ISO 8601 UTC. The list is ordered by it." })
  updated_at!: string;

  @ZodField(z.string().nullable(), { description: "When it was archived. Chats are never deleted." })
  archived_at!: string | null;

  @ZodField(z.number().int().optional(), { description: "1 once a person set the title. The first message never replaces such a title." })
  title_manual?: number;

  @ZodField(z.string().nullable().optional(), { description: "Absolute folder the agent runs in for this chat. Null means the project's folder, else a scratch folder." })
  cwd?: string | null;

  @ZodField(z.string().nullable().optional(), { description: "In chat reads and lists: the folder the next turn runs in (the chat's own, else its project's). Null means a scratch folder." })
  effective_cwd?: string | null;

  @ZodField(z.boolean().optional(), { description: "In chat lists only: true when the chat has no message and no attachment. Empty chats older than 24 hours are archived at server start." })
  empty?: boolean;

  @ZodField(z.string().nullable().optional(), { description: "In single-chat responses: a visible problem, e.g. the project's directory no longer exists and the agent runs in a scratch folder." })
  warning?: string | null;
}

@ZodObject({ description: "A page of chats, newest activity first." })
export class ChatPageDto extends ZodDto {
  @ZodField(z.array(ChatDto.schema), { description: "The chats." })
  items!: ChatDto[];

  @ZodField(z.string().nullable(), { description: "Pass as `cursor` for the next page. Null on the last page." })
  next_cursor!: string | null;
}

@ZodObject({ description: "A new chat. Pick harness, profile and model from GET /api/chat-options." })
export class ChatInputDto extends ZodDto {
  @ZodField(z.string().max(100).nullable().optional(), { description: "Project to put the chat in." })
  project_id?: string | null;

  @ZodField(z.string().max(200).optional(), { description: "Title. Default `New chat`." })
  title?: string;

  @ZodField(z.string().max(100), { description: "Harness id. Not checked here: a disabled or missing harness is reported when a message is sent." })
  harness!: string;

  @ZodField(z.string().max(200), { description: "Profile name; empty when no profile is usable yet." })
  profile!: string;

  @ZodField(z.string().max(200).nullable().optional(), { description: "Catalog model id from the profile's list. Omit for the profile's default." })
  model_id?: string | null;

  @ZodField(z.string().max(1000).nullable().optional(), { description: "Folder to run in. Same rules as PATCH /api/chats/{id}/folder. Omit to use the project's folder." })
  cwd?: string | null;
}

@ZodObject({ description: "A new harness, profile and model for the next turn. Allowed between turns, not while a reply runs." })
export class ChatConfigDto extends ZodDto {
  @ZodField(z.string().min(1).max(100), { description: "Harness id." })
  harness!: string;

  @ZodField(z.string().min(1).max(200), { description: "Profile name." })
  profile!: string;

  @ZodField(z.string().max(200).nullable(), { description: "Catalog model id, or null for the profile's default." })
  model_id!: string | null;
}

/** Longest chat title; the server enforces the same cap (MAX_TITLE_CHARS). */
export const CHAT_TITLE_MAX = 200;

@ZodObject({ description: "A new title." })
export class ChatRenameDto extends ZodDto {
  @ZodField(z.string().trim().min(1).max(CHAT_TITLE_MAX), { description: "The title, trimmed, 1 to 200 characters." })
  title!: string;
}

@ZodObject({ description: "The project to move a chat to." })
export class ChatProjectDto extends ZodDto {
  @ZodField(z.string().max(100).nullable(), { description: "Project id, or null to take the chat out of its project." })
  project_id!: string | null;
}

// ---- folders ----

@ZodObject({ description: "Which folder to list." })
export class FolderQueryDto extends ZodDto {
  @ZodField(z.string().max(1000).optional(), { description: "An allowed root, or a folder inside one. Default: the first root of settings.chat_roots (`~/sandbox/private`)." })
  root?: string;
}

@ZodObject({ description: "A folder a chat may run in." })
export class FolderItemDto extends ZodDto {
  @ZodField(z.string(), { description: "Real absolute path." })
  path!: string;

  @ZodField(z.string(), { description: "Folder name." })
  name!: string;

  @ZodField(z.string().nullable(), { description: "When a chat or project last picked it. Null when never." })
  last_used_at!: string | null;
}

@ZodObject({ description: "Child folders of a root. Recently used first, then by name; dot folders and node_modules are hidden; at most 200." })
export class FolderListDto extends ZodDto {
  @ZodField(z.string(), { description: "The folder that was listed. Empty when no root exists." })
  root!: string;

  @ZodField(z.array(z.string()), { description: "The allowed roots (settings.chat_roots, existing ones only)." })
  roots!: string[];

  @ZodField(z.array(FolderItemDto.schema), { description: "The child folders." })
  items!: FolderItemDto[];

  @ZodField(z.boolean(), { description: "True when more than 200 folders exist and the list was cut." })
  truncated!: boolean;
}

@ZodObject({ description: "The folder to run in." })
export class FolderSetDto extends ZodDto {
  @ZodField(z.string().max(1000).nullable(), { description: "Absolute path of an existing directory inside an allowed root (symlinks are resolved first), or null to clear it." })
  path!: string | null;
}

// ---- messages and attachments ----

@ZodObject({ description: "A file attached to a message." })
export class AttachmentDto extends ZodDto {
  @ZodField(z.string(), { description: "Id, `att-…`. Download with GET /api/attachments/{id}." })
  id!: string;

  @ZodField(z.string(), { description: "The chat it was uploaded to." })
  chat_id!: string;

  @ZodField(z.string().nullable(), { description: "The message it belongs to. Null until that message is sent." })
  message_id!: string | null;

  @ZodField(z.string(), { description: "Original filename." })
  filename!: string;

  @ZodField(z.string(), { description: "MIME type: sniffed for png, jpeg, webp and gif, else from the extension." })
  mime!: string;

  @ZodField(z.number().int(), { description: "Size in bytes." })
  size!: number;

  @ZodField(z.string(), { description: "SHA-256 of the content, hex." })
  sha256!: string;

  @ZodField(z.string(), { description: "ISO 8601 UTC." })
  created_at!: string;
}

@ZodObject({ description: "Files stored by an upload." })
export class AttachmentsDto extends ZodDto {
  @ZodField(z.array(AttachmentDto.schema), { description: "One entry per file, in request order." })
  items!: AttachmentDto[];
}

@ZodObject({ description: "One message of a chat." })
export class MessageDto extends ZodDto {
  @ZodField(z.string(), { description: "Id, `msg-…`. Sorts in creation order." })
  id!: string;

  @ZodField(z.string(), { description: "The chat." })
  chat_id!: string;

  @ZodField(ROLE, { description: "Who wrote it. `tool` rows record a tool call the agent made." })
  role!: "user" | "assistant" | "system" | "tool";

  @ZodField(z.string(), { description: "Text. For a streaming message, what has arrived so far." })
  content!: string;

  @ZodField(MESSAGE_STATUS, { description: "streaming until the reply ends; then done, error or stopped." })
  status!: "pending" | "streaming" | "done" | "error" | "stopped";

  @ZodField(z.string().nullable(), { description: "Why the reply failed, when status is error." })
  error!: string | null;

  @ZodField(z.string().nullable(), { description: "Model the agent reported using." })
  model_used!: string | null;

  @ZodField(z.number().int(), { description: "Input tokens of the reply, 0 when not reported." })
  input_tokens!: number;

  @ZodField(z.number().int(), { description: "Output tokens of the reply, 0 when not reported." })
  output_tokens!: number;

  @ZodField(z.number().nullable(), { description: "Cost in USD when the harness reports it." })
  cost_usd!: number | null;

  @ZodField(z.string().nullable(), { description: "When the reply started." })
  started_at!: string | null;

  @ZodField(z.string().nullable(), { description: "When the reply ended." })
  finished_at!: string | null;

  @ZodField(z.string(), { description: "ISO 8601 UTC." })
  created_at!: string;

  @ZodField(z.union([z.boolean(), z.number()]).optional(), { description: "Truthy when older history was left out of the prompt to fit the context. Stored rows carry 0 or 1, SSE carries a boolean." })
  context_truncated?: boolean | number;

  @ZodField(z.string().nullable().optional(), { description: "A visible problem with this reply, e.g. the session could not be resumed." })
  warning?: string | null;

  @ZodField(z.array(z.looseObject({ type: z.string() })).nullable().optional(), { description: "Typed parts (text, reasoning, tool-call, todo, file, diff; see src/shared/chat-parts.ts). Null on rows stored before parts existed: render `content`." })
  parts?: Array<{ type: string; [key: string]: unknown }> | null;

  @ZodField(z.array(AttachmentDto.schema), { description: "Files attached to this message." })
  attachments!: AttachmentDto[];
}

@ZodObject({ description: "A page of messages, newest first." })
export class MessagePageDto extends ZodDto {
  @ZodField(z.array(MessageDto.schema), { description: "The messages, newest first. Reverse them to display." })
  items!: MessageDto[];

  @ZodField(z.string().nullable(), { description: "Pass as `cursor` for older messages. Null when there are none." })
  next_cursor!: string | null;
}

@ZodObject({ description: "A message to send." })
export class SendMessageDto extends ZodDto {
  @ZodField(z.string().max(100000), { description: "The text. May be empty when attachments are given." })
  content!: string;

  @ZodField(z.array(z.string().max(100)).max(20).optional(), { description: "Ids of files uploaded to this chat and not yet sent." })
  attachment_ids?: string[];
}

@ZodObject({ description: "The turn has started. Follow it on GET /api/chats/{id}/events." })
export class SendResultDto extends ZodDto {
  @ZodField(z.string(), { description: "Id of the stored user message." })
  user_message_id!: string;

  @ZodField(z.string(), { description: "Id of the assistant message that is now streaming." })
  assistant_message_id!: string;
}

@ZodObject({ description: "Result of a stop request." })
export class StopResultDto extends ZodDto {
  @ZodField(z.boolean(), { description: "Always true." })
  ok!: boolean;

  @ZodField(z.boolean(), { description: "False when no reply was running." })
  stopped!: boolean;
}

@ZodObject({ description: "A chat, archived or restored." })
export class ChatEnvelopeDto extends ZodDto {
  @ZodField(ChatDto.schema, { description: "The chat after the change." })
  chat!: ChatDto;
}

@ZodObject({ description: "A project, archived or restored." })
export class ProjectEnvelopeDto extends ZodDto {
  @ZodField(ProjectDto.schema, { description: "The project after the change." })
  project!: ProjectDto;
}

// ---- search ----

@ZodObject({ description: "A message that matches a search." })
export class SearchHitDto extends ZodDto {
  @ZodField(z.string(), { description: "The matching message." })
  message_id!: string;

  @ZodField(z.string(), { description: "Its chat." })
  chat_id!: string;

  @ZodField(z.string(), { description: "The chat's title." })
  chat_title!: string;

  @ZodField(z.string().nullable(), { description: "The chat's project." })
  project_id!: string | null;

  @ZodField(ROLE, { description: "Who wrote the message." })
  role!: "user" | "assistant" | "system" | "tool";

  @ZodField(z.string(), { description: "Text around the match, with matches wrapped in `[[` and `]]`." })
  snippet!: string;

  @ZodField(z.string(), { description: "ISO 8601 UTC." })
  created_at!: string;
}

@ZodObject({ description: "Search results, best match first." })
export class SearchResultDto extends ZodDto {
  @ZodField(z.array(SearchHitDto.schema), { description: "The hits." })
  items!: SearchHitDto[];
}

// ---- pickers ----

@ZodObject({ description: "A model a profile may use." })
export class ModelOptionDto extends ZodDto {
  @ZodField(z.string(), { description: "Catalog id. Send this as `model_id`." })
  id!: string;

  @ZodField(z.string(), { description: "Name to show." })
  label!: string;

  @ZodField(z.string(), { description: "What is passed to the harness." })
  slug!: string;

  @ZodField(z.string(), { description: "Catalog description." })
  description!: string;

  @ZodField(z.boolean(), { description: "True for the profile's own model, used when `model_id` is null." })
  default!: boolean;
}

@ZodObject({ description: "A profile on a harness." })
export class ProfileOptionDto extends ZodDto {
  @ZodField(z.string(), { description: "Profile name. Send this as `profile`." })
  name!: string;

  @ZodField(z.string(), { description: "Profile description." })
  description!: string;

  @ZodField(z.boolean(), { description: "False when the profile or its harness is disabled. Show it greyed out." })
  enabled!: boolean;

  @ZodField(z.boolean(), { description: "False when an env var or auth variable the profile needs is not set." })
  configured!: boolean;

  @ZodField(z.string().nullable(), { description: "What is missing when `configured` is false." })
  problem!: string | null;

  @ZodField(z.array(ModelOptionDto.schema), { description: "Models the profile allows. One entry means the picker has no real choice." })
  models!: ModelOptionDto[];
}

@ZodObject({ description: "A harness and its profiles." })
export class HarnessOptionDto extends ZodDto {
  @ZodField(z.string(), { description: "Harness id. Send this as `harness`." })
  id!: string;

  @ZodField(z.string(), { description: "Name to show." })
  label!: string;

  @ZodField(z.boolean(), { description: "False when listed in settings.disabled_harnesses." })
  enabled!: boolean;

  @ZodField(z.boolean(), { description: "Whether the harness's program is installed on this machine." })
  available!: boolean;

  @ZodField(z.boolean(), { description: "True when one live process serves a whole chat. False when each message starts a process and only resumes the session if the adapter can." })
  persistent!: boolean;

  @ZodField(z.enum(["process", "session", "replay"]).optional(), { description: "How the chat remembers: one live process, the harness's own session resumed per message, or recent history replayed in the prompt." })
  memory?: "process" | "session" | "replay";

  @ZodField(z.array(ProfileOptionDto.schema), { description: "Profiles on this harness." })
  profiles!: ProfileOptionDto[];
}

@ZodObject({ description: "Everything the harness, profile and model pickers need." })
export class ChatOptionsDto extends ZodDto {
  @ZodField(z.array(HarnessOptionDto.schema), { description: "Every harness, enabled or not." })
  harnesses!: HarnessOptionDto[];

  @ZodField(z.string().nullable(), { description: "Harness of settings.default_profile." })
  default_harness!: string | null;

  @ZodField(z.string().nullable(), { description: "settings.default_profile." })
  default_profile!: string | null;
}
