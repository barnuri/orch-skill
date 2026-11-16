// Pure rules for a chat's subfolder; shared by the server and the dashboard (no Bun or Node imports).
export const MAX_SUBFOLDER_NAME = 200;
export const MAX_SUBFOLDER_DEPTH = 6;

export class SubfolderError extends Error {}

/** A relative path inside a project folder, normalised (trimmed, duplicate slashes collapsed, no trailing slash). Null or blank means none. */
export function normaliseSubfolder(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.includes("\0")) {
    throw new SubfolderError("subfolder: must not contain a NUL character");
  }
  if (trimmed.includes("\\")) {
    throw new SubfolderError("subfolder: must not contain a backslash");
  }
  if (trimmed.startsWith("~")) {
    throw new SubfolderError("subfolder: must be relative to the project folder, not start with ~");
  }
  if (trimmed.startsWith("/")) {
    throw new SubfolderError("subfolder: must be relative to the project folder, not absolute");
  }
  const parts = trimmed.replace(/\/+/g, "/").replace(/\/$/, "").split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") {
      throw new SubfolderError(`subfolder: must not contain empty, . or .. segments`);
    }
    if (part.length > MAX_SUBFOLDER_NAME) {
      throw new SubfolderError(`subfolder: a folder name is longer than ${MAX_SUBFOLDER_NAME} characters`);
    }
  }
  if (parts.length > MAX_SUBFOLDER_DEPTH) {
    throw new SubfolderError(`subfolder: more than ${MAX_SUBFOLDER_DEPTH} levels deep`);
  }
  return parts.join("/");
}
