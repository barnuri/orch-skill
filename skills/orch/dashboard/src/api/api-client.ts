import type { ApiError } from "../../../shared/types/api-error";
import type { DocumentKind } from "../../../shared/types/document-kind";
import type { HealthResponse } from "../../../shared/types/health-response";
import type { PutOk } from "../../../shared/types/put-ok";
import type { RunEnvelope } from "../../../shared/types/run-envelope";
import type { RunsEnvelope } from "../../../shared/types/runs-envelope";
import { API_BASE } from "../constants";
import type { ApiResult } from "./api-result";
import { getToken } from "./token-store";

type Method = "GET" | "PUT";
type RequestOptions = { etag?: string | null; ifMatch?: string; body?: unknown };

// Thin, stateless wrapper over fetch: the token comes from token-store on every call, so a
// gate-supplied token is picked up by the very next request. Maps every outcome onto ApiResult
// — callers never need try/catch.
export class ApiClient {
  private static readonly JSON_MEDIA_TYPE: string = "application/json";

  private static isApiError(value: unknown): value is ApiError {
    return typeof value === "object" && value !== null && typeof (value as ApiError).error === "string";
  }

  private static async parseJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch (err) {
      if (err instanceof Error) {
        return undefined;
      }
      throw err;
    }
  }

  getRuns(etag: string | null): Promise<ApiResult<RunsEnvelope>> {
    return this.request<RunsEnvelope>("GET", `${API_BASE}/runs`, { etag });
  }

  getRun(id: string, etag: string | null): Promise<ApiResult<RunEnvelope>> {
    return this.request<RunEnvelope>("GET", `${API_BASE}/runs/${encodeURIComponent(id)}`, { etag });
  }

  getDocument<T>(kind: DocumentKind, etag: string | null): Promise<ApiResult<T>> {
    return this.request<T>("GET", `${API_BASE}/${kind}`, { etag });
  }

  putDocument(kind: DocumentKind, body: unknown, ifMatch: string): Promise<ApiResult<PutOk>> {
    return this.request<PutOk>("PUT", `${API_BASE}/${kind}`, { ifMatch, body });
  }

  health(): Promise<ApiResult<HealthResponse>> {
    return this.request<HealthResponse>("GET", `${API_BASE}/health`);
  }

  private headersFor(method: Method, options: RequestOptions): Headers {
    const headers = new Headers();
    const token = getToken();
    if (token !== null) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    if (options.etag) {
      headers.set("If-None-Match", options.etag);
    }
    if (options.ifMatch !== undefined) {
      headers.set("If-Match", options.ifMatch);
    }
    if (method === "PUT") {
      headers.set("Content-Type", ApiClient.JSON_MEDIA_TYPE);
    }
    return headers;
  }

  private async request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    const init: RequestInit = { method, headers: this.headersFor(method, options), cache: "no-store" };
    if (method === "PUT") {
      init.body = JSON.stringify(options.body);
    }
    let res: Response;
    try {
      res = await fetch(path, init);
    } catch (err) {
      if (err instanceof Error) {
        return { kind: "network" };
      }
      throw err;
    }
    if (res.status === 304) {
      return { kind: "unchanged" };
    }
    const parsed = await ApiClient.parseJson(res);
    if (res.ok && parsed !== undefined) {
      return { kind: "ok", body: parsed as T, etag: res.headers.get("ETag") };
    }
    return { kind: "error", status: res.status, body: ApiClient.isApiError(parsed) ? parsed : null };
  }
}
