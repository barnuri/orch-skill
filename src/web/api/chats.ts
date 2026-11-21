import type { z } from "zod";
import {
  AttachmentsDto,
  ChatDto,
  ChatEnvelopeDto,
  ChatOptionsDto,
  ChatPageDto,
  FolderListDto,
  MessagePageDto,
  ProjectDto,
  ProjectEnvelopeDto,
  ProjectPageDto,
  SearchResultDto,
  SendResultDto,
  StopResultDto,
} from "../../shared/dto/chats";
import type { Attachment, Chat, FolderList, ChatOptions, Message, Page, Project, SearchHit } from "../lib/chat-types";
import { API_BASE } from "../lib/constants";
import { OkDto } from "../../shared/dto/common";
import { api } from "./client";
import type { ApiResult } from "./result";
import { getToken } from "./token";

/** zod infers arrays of a decorated DTO as `{}`, so each schema is narrowed to the plain DTO type once, here. */
function typed<T>(schema: unknown): z.ZodType<T> {
  return schema as z.ZodType<T>;
}

const optionsSchema = typed<ChatOptions>(ChatOptionsDto.schema);
const chatSchema = typed<Chat>(ChatDto.schema);
const projectSchema = typed<Project>(ProjectDto.schema);
const chatEnvelope = typed<{ chat: Chat }>(ChatEnvelopeDto.schema);
const projectEnvelope = typed<{ project: Project }>(ProjectEnvelopeDto.schema);
const chatPage = typed<Page<Chat>>(ChatPageDto.schema);
const projectPage = typed<Page<Project>>(ProjectPageDto.schema);
const messagePage = typed<Page<Message>>(MessagePageDto.schema);
const searchSchema = typed<{ items: SearchHit[] }>(SearchResultDto.schema);
const attachmentsSchema = typed<{ items: Attachment[] }>(AttachmentsDto.schema);
const sendSchema = typed<{ user_message_id: string; assistant_message_id: string }>(SendResultDto.schema);
const stopSchema = typed<{ ok: boolean; stopped: boolean }>(StopResultDto.schema);

const folderSchema = typed<FolderList>(FolderListDto.schema);
const okSchema = typed<{ ok: boolean }>(OkDto.schema);

const q = encodeURIComponent;

function query(params: Record<string, string | number | undefined | null>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${q(String(v))}`);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

function get<T>(path: string, schema: z.ZodType<T>): Promise<ApiResult<T>> {
  return api.request("GET", `${API_BASE}${path}`, schema, { quiet: true });
}

function post<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<ApiResult<T>> {
  return api.request("POST", `${API_BASE}${path}`, schema, { body });
}

export const chatsApi = {
  options: (use?: "runs") => get(`/chat-options${use === undefined ? "" : `?use=${use}`}`, optionsSchema),
  projects: (archived: boolean) => get(`/projects${query({ archived: archived ? 1 : 0, limit: 100 })}`, projectPage),
  createProject: (body: { name: string; path?: string | null; description?: string; parent_id?: string | null }) => post("/projects", projectSchema, body),
  updateProject: (id: string, body: { name?: string; path?: string | null; description?: string }) =>
    api.request("PUT", `${API_BASE}/projects/${q(id)}`, projectSchema, { body }),
  archiveProject: (id: string, on: boolean) => post(`/projects/${q(id)}/${on ? "archive" : "unarchive"}`, projectEnvelope),
  chats: (params: { project_id?: string; archived?: boolean; cursor?: string | null; limit?: number }) =>
    get(`/chats${query({ project_id: params.project_id, archived: params.archived ? 1 : 0, cursor: params.cursor, limit: params.limit ?? 50 })}`, chatPage),
  chat: (id: string) => get(`/chats/${q(id)}`, chatSchema),
  createChat: (body: { project_id: string | null; harness: string; profile: string; model_id: string | null; cwd?: string | null; subfolder?: string | null; effort?: string | null }) => post("/chats", chatSchema, body),
  folders: (root?: string, depth?: 1 | 2) => get(`/chats/folders${query({ root, depth })}`, folderSchema),
  setChatFolder: (id: string, path: string | null) => api.request("PATCH", `${API_BASE}/chats/${q(id)}/folder`, chatEnvelope, { body: { path } }),
  setChatSubfolder: (id: string, subfolder: string | null) => api.request("PATCH", `${API_BASE}/chats/${q(id)}`, chatEnvelope, { body: { subfolder } }),
  setProjectFolder: (id: string, path: string | null) => api.request("PATCH", `${API_BASE}/projects/${q(id)}/folder`, projectEnvelope, { body: { path } }),
  rename: (id: string, title: string) => post(`/chats/${q(id)}/rename`, chatEnvelope, { title }),
  moveChat: (id: string, project_id: string | null) => post(`/chats/${q(id)}/project`, chatEnvelope, { project_id }),
  configure: (id: string, body: { harness: string; profile: string; model_id: string | null; effort?: string | null }) => post(`/chats/${q(id)}/config`, chatEnvelope, body),
  archiveChat: (id: string, on: boolean) => post(`/chats/${q(id)}/${on ? "archive" : "unarchive"}`, chatEnvelope),
  search: (text: string) => get(`/chats/search${query({ q: text, limit: 30 })}`, searchSchema),
  messages: (id: string, cursor: string | null, limit = 30) => get(`/chats/${q(id)}/messages${query({ cursor, limit })}`, messagePage),
  send: (id: string, content: string, attachmentIds: readonly string[]) =>
    post(`/chats/${q(id)}/messages`, sendSchema, { content, attachment_ids: attachmentIds.length > 0 ? attachmentIds : undefined }),
  removeAttachment: (id: string) => post(`/attachments/${q(id)}/delete`, okSchema),
  stop: (id: string) => post(`/chats/${q(id)}/stop`, stopSchema),
};

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}

export function eventsUrl(chatId: string): string {
  return `${API_BASE}/chats/${q(chatId)}/events`;
}

export interface UploadHandle {
  promise: Promise<{ ok: true; attachment: Attachment } | { ok: false; error: string }>;
  abort: () => void;
}

/** Uploads one file with progress (fetch has no upload progress, XHR does). */
export function uploadAttachment(chatId: string, file: File, onProgress: (fraction: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ ok: true; attachment: Attachment } | { ok: false; error: string }>((resolve) => {
    xhr.open("POST", `${API_BASE}/chats/${q(chatId)}/attachments`);
    for (const [k, v] of Object.entries(authHeaders())) {
      xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        onProgress(e.loaded / e.total);
      }
    };
    xhr.onerror = () => resolve({ ok: false, error: "network error" });
    xhr.onabort = () => resolve({ ok: false, error: "cancelled" });
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      const checked = attachmentsSchema.safeParse(body);
      if (xhr.status >= 200 && xhr.status < 300 && checked.success && checked.data.items[0] !== undefined) {
        resolve({ ok: true, attachment: checked.data.items[0] });
        return;
      }
      const message = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${xhr.status}`;
      resolve({ ok: false, error: message });
    };
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

const blobUrls = new Map<string, Promise<string | null>>();

/** Attachments sit behind the bearer token, so an <img src> cannot load them: fetch with the header and hand out an object URL. */
export function attachmentBlobUrl(id: string): Promise<string | null> {
  let hit = blobUrls.get(id);
  if (hit === undefined) {
    hit = fetch(`${API_BASE}/attachments/${q(id)}`, { headers: authHeaders() })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => (blob === null ? null : URL.createObjectURL(blob)))
      .catch(() => null)
      .then((url) => {
        // A failure (offline, 401 before the token) is not cached, so the next mount or download tries again.
        if (url === null) {
          blobUrls.delete(id);
        }
        return url;
      });
    blobUrls.set(id, hit);
  }
  return hit;
}

export async function downloadAttachment(att: Attachment): Promise<boolean> {
  const url = await attachmentBlobUrl(att.id);
  if (url === null) {
    return false;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = att.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
}
