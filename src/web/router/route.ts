export type Route =
  | { kind: "list" }
  | { kind: "run"; runId: string }
  | { kind: "chats"; chatId: string | null; projectId?: string | null }
  | { kind: "project"; projectId: string }
  | { kind: "profiles" }
  | { kind: "harnesses" }
  | { kind: "schedules" }
  | { kind: "memory" }
  | { kind: "suggestions" };

export type RouteKind = Route["kind"];

const RUN_HASH = /^#\/run\/(.+)$/;
const CHAT_HASH = /^#\/chats\/(.+)$/;
const PROJECT_HASH = /^#\/projects\/(.+)$/;
const SECTION_HASHES: Readonly<Record<string, Route>> = {
  "#/chats": { kind: "chats", chatId: null },
  "#/profiles": { kind: "profiles" },
  "#/harnesses": { kind: "harnesses" },
  "#/schedules": { kind: "schedules" },
  "#/memory": { kind: "memory" },
  "#/suggestions": { kind: "suggestions" },
};

// The hash is user-controlled: a malformed escape must fall back to the list, not throw.
function decodeRunId(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    if (err instanceof URIError) {
      return null;
    }
    throw err;
  }
}

export function parseRoute(hash: string): Route {
  const section = SECTION_HASHES[hash];
  if (section !== undefined) {
    return section;
  }
  const chat = CHAT_HASH.exec(hash);
  if (chat !== null) {
    const parts = (chat[1] ?? "").split("/");
    if (parts.length === 2) {
      const projectId = decodeRunId(parts[0] ?? "");
      const deepChat = decodeRunId(parts[1] ?? "");
      if (projectId !== null && projectId !== "" && deepChat !== null && deepChat !== "") {
        return { kind: "chats", chatId: deepChat, projectId };
      }
    }
    const chatId = chat[1] === undefined ? null : decodeRunId(chat[1]);
    return chatId === null || chatId === "" ? { kind: "chats", chatId: null } : { kind: "chats", chatId };
  }
  const project = PROJECT_HASH.exec(hash);
  if (project !== null) {
    const projectId = project[1] === undefined ? null : decodeRunId(project[1]);
    return projectId === null || projectId === "" ? { kind: "chats", chatId: null } : { kind: "project", projectId };
  }
  // `?status=…&q=…` after the run id is the run page's node filter, not part of the id.
  const match = RUN_HASH.exec(hash);
  const rawId = match?.[1]?.split("?")[0];
  const runId = rawId === undefined ? null : decodeRunId(rawId);
  if (runId === null || runId === "") {
    return { kind: "list" };
  }
  return { kind: "run", runId };
}

export function routeKey(route: Route): string {
  return route.kind === "run"
    ? `run:${route.runId}`
    : route.kind === "chats"
      ? `chats:${route.chatId ?? ""}`
      : route.kind === "project"
        ? `project:${route.projectId}`
        : route.kind;
}

// The run view belongs to the Runs section, so `#/run/<id>` highlights `#/`.
export const SECTION_HREF: Readonly<Record<RouteKind, string>> = {
  list: "#/",
  run: "#/",
  chats: "#/chats",
  project: "#/chats",
  profiles: "#/profiles",
  harnesses: "#/harnesses",
  schedules: "#/schedules",
  memory: "#/memory",
  suggestions: "#/suggestions",
};

export const NAV_LINKS: readonly { href: string; label: string }[] = [
  { href: "#/", label: "Runs" },
  { href: "#/chats", label: "Chats" },
  { href: "#/profiles", label: "Profiles" },
  { href: "#/harnesses", label: "Harnesses" },
  { href: "#/schedules", label: "Schedules" },
  { href: "#/memory", label: "Memory" },
  { href: "#/suggestions", label: "Suggestions" },
];
