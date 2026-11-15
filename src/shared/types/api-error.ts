import type { Issue } from "./issue";

export interface ApiError {
  error: string;
  issues?: Issue[];
  etag?: string;
}
