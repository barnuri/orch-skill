import type { z } from "zod";
import { WorkspaceDto, WorkspaceMemoryDto, workspaceFileSchema } from "../../shared/dto/workspace";
import { OkDto } from "../../shared/dto/common";
import { API_BASE } from "../lib/constants";
import { api } from "./client";
import type { ApiResult } from "./result";
import { authHeaders } from "./chats";

export type Scope = "chat" | "folder";
export type Area = "knowledge" | "artifacts";
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;
export interface WorkspaceInfo {
  scope: Scope;
  path: string;
  exists: boolean;
  has_folder: boolean;
  moved_from: string | null;
  memory_size: number;
  files: Record<Area, WorkspaceFile[]>;
}
export interface WorkspaceMemory { content: string; exists: boolean; modified: string | null }

const infoSchema = WorkspaceDto.schema as unknown as z.ZodType<WorkspaceInfo>;
const memorySchema = WorkspaceMemoryDto.schema as unknown as z.ZodType<WorkspaceMemory>;
const okSchema = OkDto.schema as unknown as z.ZodType<{ ok: boolean }>;
const q = encodeURIComponent;
const base = (id: string, _scope: Scope): string => `${API_BASE}/chats/${q(id)}/workspace`;
const scoped = (scope: Scope): string => `?scope=${scope}`;

async function failureText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export const workspaceApi = {
  info: (id: string, scope: Scope): Promise<ApiResult<WorkspaceInfo>> => api.request("GET", `${base(id, scope)}${scoped(scope)}`, infoSchema, { quiet: true }),
  memory: (id: string, scope: Scope): Promise<ApiResult<WorkspaceMemory>> => api.request("GET", `${base(id, scope)}/memory${scoped(scope)}`, memorySchema, { quiet: true }),
  saveMemory: (id: string, scope: Scope, content: string): Promise<ApiResult<WorkspaceMemory>> =>
    api.request("PUT", `${base(id, scope)}/memory${scoped(scope)}`, memorySchema, { body: { content } }),
  remove: (id: string, scope: Scope, area: Area, name: string): Promise<ApiResult<{ ok: boolean }>> =>
    api.request("DELETE", `${base(id, scope)}/files/${area}/${q(name)}${scoped(scope)}`, okSchema),
  /** Uploads one file; resolves with an error text, or null on success. */
  async upload(id: string, scope: Scope, area: Area, file: File): Promise<string | null> {
    try {
      const res = await fetch(`${base(id, scope)}/files/${area}${scoped(scope)}`, { method: "POST", headers: { ...authHeaders(), "X-Filename": q(file.name) }, body: file });
      return res.ok ? null : await failureText(res);
    } catch {
      return "network error";
    }
  },
  /** The file (or the zip when `name` is null) as a Blob, or an error text. */
  async fetchBlob(id: string, scope: Scope, area: Area | null, name: string | null): Promise<{ blob: Blob } | { error: string }> {
    const url = area === null || name === null ? `${base(id, scope)}/export${scoped(scope)}` : `${base(id, scope)}/files/${area}/${q(name)}${scoped(scope)}`;
    try {
      const res = await fetch(url, { headers: authHeaders() });
      return res.ok ? { blob: await res.blob() } : { error: await failureText(res) };
    } catch {
      return { error: "network error" };
    }
  },
};

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => { URL.revokeObjectURL(url); }, 10_000);
}

