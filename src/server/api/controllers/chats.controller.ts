import { parseParts } from "../../../shared/chat-parts";
import { Body, Controller, Get, Param, Patch, Post, Query, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { ErrorDto, OkDto } from "../../../shared/dto/common";
import {
  AttachmentsDto, ChatConfigDto, ChatDto, ChatEnvelopeDto, ChatIdParamsDto, ChatInputDto, ChatOptionsDto, ChatPageDto,
  ChatProjectDto, ChatRenameDto, FolderListDto, FolderQueryDto, FolderSetDto, PageQueryDto, ChatSearchQueryDto, ChatsQueryDto, MessagePageDto, SearchResultDto,
  SendMessageDto, SendResultDto, StopResultDto,
} from "../../../shared/dto/chats";
import { type ChatService, chatServiceFor, HttpError } from "../../chats/service";
import { eventStream } from "../../chats/sse";
import { deleteUnattached, saveUploads, serveAttachment, UploadError } from "../../chats/uploads";
import type { AttachmentRow, MessageRow } from "../../chats/types";
import { jsonResponse } from "../../http/responses";
import type { ServerContext } from "../../types/server-context";
import type { ApiContext } from "../pipeline";
import { failure, idOf } from "./projects.controller";
import { valid } from "./support";

const publicAttachment = ({ rel_path: _rel, ...rest }: AttachmentRow): Omit<AttachmentRow, "rel_path"> => rest;

function publicMessage(row: MessageRow & { attachments: AttachmentRow[] }): unknown {
  return { ...row, parts: parseParts(row.parts), attachments: row.attachments.map(publicAttachment) };
}

function guarded(work: () => Response | Promise<Response>): Promise<Response> {
  return Promise.resolve()
    .then(work)
    .catch((err: unknown) => {
      if (err instanceof UploadError) {
        return jsonResponse(err.status, { error: err.message });
      }
      return failure(err);
    });
}

@Controller({ path: "/api", tags: ["chats"] })
export class ChatsController {
  private readonly service: ChatService;

  constructor(ctx: ServerContext) {
    this.service = chatServiceFor(ctx);
  }

  @Get("/chat-options", {
    summary: "Harness, profile and model choices",
    description: "Every harness with its profiles and each profile's allowed models, for the three pickers of a new chat. `enabled` follows settings.disabled_harnesses and the profile's `enabled`; `configured` is false when a needed env var is unset; `persistent` says whether one live process serves the chat. A picker with one entry has no real choice: show it disabled.",
  })
  @ResponseSchema(ChatOptionsDto.schema, { description: "The choices." })
  options(): Response {
    return jsonResponse(200, this.service.options());
  }

  @Get("/chats/search", {
    summary: "Search all chat history",
    description: "Full-text search over every finished message, archived chats included. Every word must match; the last word matches as a prefix. Best match first; matches in `snippet` are wrapped in `[[` and `]]`.",
  })
  @Query(ChatSearchQueryDto.schema)
  @ResponseSchema(SearchResultDto.schema, { description: "The hits." })
  search(c: ApiContext): Response {
    const q = valid<{ q: string; project_id?: string; limit?: number }>(c, "query");
    return jsonResponse(200, { items: this.service.store.search(q.q, { projectId: q.project_id, limit: q.limit }) });
  }

  @Get("/chats/folders", {
    summary: "Folders a chat can run in",
    description: "Child directories of `root` (an allowed root or a folder inside one; default the first of settings.chat_roots, `~/sandbox/private`). Recently used first, then by name. Dot folders and node_modules are hidden; at most 200. Answers 400 when `root` is not allowed.",
  })
  @Query(FolderQueryDto.schema)
  @ResponseSchema(FolderListDto.schema, { description: "The folders." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Root not allowed." })
  folders(c: ApiContext): Response {
    try {
      return jsonResponse(200, this.service.folders(valid<{ root?: string }>(c, "query").root));
    } catch (err) {
      return failure(err);
    }
  }

  @Patch("/chats/{id}/folder", {
    summary: "Set a chat's folder",
    description: "The agent runs in this folder from the next turn; a reply that already streams keeps its old folder. The path must be absolute, exist, be a directory and resolve (symlinks followed) inside an allowed root. `null` clears it, so the project's folder applies. Answers 400 with the reason otherwise.",
  })
  @Param(ChatIdParamsDto.schema)
  @Body(FolderSetDto.schema)
  @ResponseSchema(ChatEnvelopeDto.schema, { description: "The chat after the change." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Folder not allowed." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such chat." })
  setFolder(c: ApiContext): Response {
    try {
      const chat = this.service.setChatFolder(idOf(c), valid<{ path: string | null }>(c, "json").path);
      return jsonResponse(200, { chat: { ...chat, effective_cwd: this.service.effectiveCwd(chat) } });
    } catch (err) {
      return failure(err);
    }
  }

  @Get("/chats", {
    summary: "List chats",
    description: "Active chats, newest activity first, paged by cursor (default 30, max 100). `project_id` filters to one project (`none` for chats without one); `archived=1` lists archived chats.",
  })
  @Query(ChatsQueryDto.schema)
  @ResponseSchema(ChatPageDto.schema, { description: "A page of chats." })
  list(c: ApiContext): Response {
    const q = valid<{ limit?: number; cursor?: string; project_id?: string; archived?: string }>(c, "query");
    const page = this.service.store.listChats({ projectId: q.project_id, archived: q.archived === "1" || q.archived === "true", limit: q.limit, cursor: q.cursor });
    return jsonResponse(200, { ...page, items: page.items.map((row) => ({ ...row, effective_cwd: this.service.effectiveCwd(row), empty: this.service.store.chatIsEmpty(row.id) })) });
  }

  @Post("/chats", {
    summary: "Create a chat",
    description: "Creates an empty chat on a harness, profile and model. Never refused for a disabled, missing or unconfigured harness (reported when a message is sent). Answers 400 only when the project is unknown or archived.",
  })
  @Body(ChatInputDto.schema)
  @ResponseSchema(ChatDto.schema, { status: 201, description: "Created." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Invalid choice." })
  create(c: ApiContext): Response {
    try {
      return jsonResponse(201, this.service.createChat(valid(c, "json")));
    } catch (err) {
      return failure(err);
    }
  }

  @Get("/chats/{id}", {
    summary: "Read a chat",
    description: "One chat, archived or not.",
  })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(ChatDto.schema, { description: "The chat." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such chat." })
  read(c: ApiContext): Response {
    try {
      const chat = this.service.chat(idOf(c));
      return jsonResponse(200, { ...chat, effective_cwd: this.service.effectiveCwd(chat), warning: this.service.warningFor(chat) });
    } catch (err) {
      return failure(err);
    }
  }

  @Post("/chats/{id}/rename", {
    summary: "Rename a chat",
    description: "Sets the title: trimmed, 1 to 200 characters. A renamed chat keeps its title; the first message no longer replaces it.",
  })
  @Param(ChatIdParamsDto.schema)
  @Body(ChatRenameDto.schema)
  @ResponseSchema(ChatEnvelopeDto.schema, { description: "The chat after the change." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Empty or too long." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such chat." })
  rename(c: ApiContext): Response {
    try {
      return jsonResponse(200, { chat: this.service.renameChat(idOf(c), valid<{ title: string }>(c, "json").title) });
    } catch (err) {
      return failure(err);
    }
  }

  @Post("/chats/{id}/project", {
    summary: "Move a chat to a project",
    description: "Sets or clears the chat's project. Allowed at any time. Answers 400 for an unknown or archived project.",
  })
  @Param(ChatIdParamsDto.schema)
  @Body(ChatProjectDto.schema)
  @ResponseSchema(ChatEnvelopeDto.schema, { description: "The chat after the change." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such chat." })
  setProject(c: ApiContext): Response {
    try {
      return jsonResponse(200, { chat: this.service.setChatProject(idOf(c), valid<{ project_id: string | null }>(c, "json").project_id) });
    } catch (err) {
      return failure(err);
    }
  }

  @Post("/chats/{id}/config", {
    summary: "Change a chat's harness, profile or model",
    description: "Allowed between turns (409 while a reply runs). Answers 400 for a disabled harness or profile or a model outside the allowed list. A changed harness drops the stored session id; its history is replayed.",
  })
  @Param(ChatIdParamsDto.schema)
  @Body(ChatConfigDto.schema)
  @ResponseSchema(ChatEnvelopeDto.schema, { description: "The chat after the change." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Invalid choice." })
  @ResponseSchema(ErrorDto.schema, { status: 409, description: "The chat already has messages." })
  config(c: ApiContext): Response {
    try {
      return jsonResponse(200, { chat: this.service.configureChat(idOf(c), valid(c, "json")) });
    } catch (err) {
      return failure(err);
    }
  }

  @Post("/chats/{id}/archive", {
    summary: "Archive a chat",
    description: "Hides the chat from the default list. Its messages and files are kept forever. A reply that is still running keeps running.",
  })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(ChatEnvelopeDto.schema, { description: "The archived chat." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such chat." })
  archive(c: ApiContext): Response {
    return this.setArchived(c, true);
  }

  @Post("/chats/{id}/unarchive", {
    summary: "Restore a chat",
    description: "Brings an archived chat back into the default list.",
  })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(ChatEnvelopeDto.schema, { description: "The restored chat." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such chat." })
  unarchive(c: ApiContext): Response {
    return this.setArchived(c, false);
  }

  private setArchived(c: ApiContext, archived: boolean): Response {
    try {
      this.service.chat(idOf(c));
      return jsonResponse(200, { chat: this.service.store.setChatArchived(idOf(c), archived) });
    } catch (err) {
      return failure(err);
    }
  }

  @Get("/chats/{id}/messages", {
    summary: "List a chat's messages",
    description: "Newest first, paged by cursor (default 30, max 100). Pass `next_cursor` to get older messages. A message that is still streaming shows the text received so far.",
  })
  @Param(ChatIdParamsDto.schema)
  @Query(PageQueryDto.schema)
  @ResponseSchema(MessagePageDto.schema, { description: "A page of messages." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such chat." })
  messages(c: ApiContext): Response {
    try {
      const id = idOf(c);
      this.service.chat(id);
      const q = valid<{ limit?: number; cursor?: string }>(c, "query");
      const page = this.service.store.listMessages(id, q);
      return jsonResponse(200, { items: this.service.withAttachments(page.items).map(publicMessage), next_cursor: page.next_cursor });
    } catch (err) {
      return failure(err);
    }
  }

  @Post("/chats/{id}/messages", {
    summary: "Send a message",
    description: "Stores the user message, starts the agent's reply and answers 202 at once with both message ids. Follow the reply on GET /api/chats/{id}/events. Answers 409 while a reply is already running, 400 for an empty message, unknown attachments, or a harness, profile or model that is no longer allowed.",
  })
  @Param(ChatIdParamsDto.schema)
  @Body(SendMessageDto.schema)
  @ResponseSchema(SendResultDto.schema, { status: 202, description: "The turn has started." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Invalid message." })
  @ResponseSchema(ErrorDto.schema, { status: 409, description: "A reply is already running, or the chat is archived." })
  send(c: ApiContext): Response {
    try {
      return jsonResponse(202, this.service.sendMessage(idOf(c), valid(c, "json")));
    } catch (err) {
      return failure(err);
    }
  }

  @Post("/chats/{id}/stop", {
    summary: "Stop the running reply",
    description: "Stops the reply that is streaming. The text received so far is kept and the message ends as `stopped`. The next message resumes the same session. `stopped` is false when nothing was running.",
  })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(StopResultDto.schema, { description: "Done." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such chat." })
  stop(c: ApiContext): Promise<Response> {
    return guarded(async () => jsonResponse(200, { ok: true, stopped: await this.service.stop(idOf(c)) }));
  }

  @Post("/chats/{id}/attachments", {
    summary: "Upload files to a chat",
    description: "Send `multipart/form-data` with one or more files, or a raw body with `X-Filename` (URL-encoded) for a pasted blob. Limits: 25 MB per file, 100 MB per message. The mime type is sniffed for png, jpeg, webp and gif, otherwise taken from the extension. Names with a path separator are refused. Pass the returned ids as `attachment_ids` when sending. Identical content is stored once.",
  })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(AttachmentsDto.schema, { status: 201, description: "Stored." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "No file, empty file or bad filename." })
  @ResponseSchema(ErrorDto.schema, { status: 413, description: "A size limit was exceeded." })
  upload(c: ApiContext): Promise<Response> {
    return guarded(async () => {
      const id = idOf(c);
      this.service.chat(id);
      const rows = await saveUploads(this.service.store, this.service.home, id, c.req.raw);
      return jsonResponse(201, { items: rows.map(publicAttachment) });
    });
  }

  @Post("/attachments/{id}/delete", {
    summary: "Remove an upload that was never sent",
    description: "Deletes an attachment no message owns yet, and its file when no other attachment has the same content. Answers 409 for an attachment that belongs to a message: sent history is never changed. Uploads nobody sent are also removed 24 hours after upload, when the server starts.",
  })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Removed." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such attachment." })
  @ResponseSchema(ErrorDto.schema, { status: 409, description: "The attachment belongs to a message." })
  removeAttachment(c: ApiContext): Response {
    const id = idOf(c);
    const row = this.service.store.getAttachment(id);
    if (row === null) {
      return jsonResponse(404, { error: "no such attachment" });
    }
    if (!deleteUnattached(this.service.store, this.service.home, id)) {
      return jsonResponse(409, { error: "attachment belongs to a message and cannot be removed" });
    }
    return jsonResponse(200, { ok: true });
  }

  @Get("/chats/{id}/events", {
    summary: "Follow a chat live (Server-Sent Events)",
    description: "A `text/event-stream`. Events: `message` (a new message row: yours, the assistant's, or a tool call), `delta` (text appended to a streaming message), `usage`, `done` (a reply ended: done, error or stopped) and `status` (chat idle or running). Event ids are `<message id>.<text length>`; reconnect with `Last-Event-ID` and the server first replays what was missed from the database. Without it, the stream starts with the current status only: load history with GET /api/chats/{id}/messages.",
  })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such chat." })
  events(c: ApiContext): Response {
    try {
      const id = idOf(c);
      this.service.chat(id);
      return eventStream(this.service, id, c.req.header("last-event-id") ?? null, c.req.raw.signal);
    } catch (err) {
      return failure(err);
    }
  }

  @Get("/attachments/{id}", {
    summary: "Download an attachment",
    description: "The file with its stored Content-Type and `X-Content-Type-Options: nosniff`. png, jpeg, webp and gif are shown inline; every other type is sent as a download.",
  })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such attachment." })
  attachment(c: ApiContext): Response {
    const row = this.service.store.getAttachment(idOf(c));
    return row === null ? jsonResponse(404, { error: "no such attachment" }) : serveAttachment(this.service.home, row);
  }
}
