// Limits and rules of the chat settings in profiles.json (`settings.*`) and serve.json. Bun-free: the validator, the DTO and the
// Settings page all read the same numbers.

export const SCHEDULE_GRACE_DEFAULT_HOURS = 6;
export const SCHEDULE_GRACE_MAX_HOURS = 72;
export const CHAT_ROOTS_DEFAULT: readonly string[] = ["~/sandbox/private"];
export const CHAT_ROOTS_MAX = 20;
export const CHAT_ROOT_MAX_LENGTH = 500;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Why a chat root is not acceptable (absolute, or `~` / `~/…`, no `..` segment, no control characters), or null. */
export function chatRootProblem(root: string): string | null {
  const text = root.trim();
  if (text === "") {
    return "must not be empty";
  }
  if (text.length > CHAT_ROOT_MAX_LENGTH) {
    return `at most ${CHAT_ROOT_MAX_LENGTH} characters`;
  }
  if (CONTROL.test(text)) {
    return "must not contain control characters";
  }
  if (!(text === "~" || text.startsWith("~/") || text.startsWith("/"))) {
    return "must be an absolute path, or start with ~/";
  }
  if (text.split("/").includes("..")) {
    return "must not contain a .. segment";
  }
  return null;
}

/** The text of a roots box (one folder per line, blank lines ignored) as a list. */
export function parseRootsText(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

/** A problem sentence for the whole list, or null. */
export function chatRootsProblem(roots: readonly string[]): string | null {
  if (roots.length > CHAT_ROOTS_MAX) {
    return `at most ${CHAT_ROOTS_MAX} folders`;
  }
  for (const root of roots) {
    const why = chatRootProblem(root);
    if (why !== null) {
      return `${root.slice(0, 60)}: ${why}`;
    }
  }
  return null;
}

/** A problem sentence for the grace hours text of the Settings box (empty means the default), or null. */
export function graceHoursProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  if (!/^\d+$/.test(trimmed) || Number(trimmed) > SCHEDULE_GRACE_MAX_HOURS) {
    return `Enter a whole number from 0 to ${SCHEDULE_GRACE_MAX_HOURS}.`;
  }
  return null;
}
