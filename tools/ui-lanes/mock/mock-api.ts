// In-memory API for the fast mock lane. A pure `Request -> Response` function: it reads only the
// fixtures in ./fixtures.ts. It never opens a socket, a file or the orch home.
import {
  ACTIVE_ENVELOPE,
  BUILD_INFO,
  HARNESSES_ENVELOPE,
  HEALTH,
  HEALTH_SUMMARY,
  SERVER_INFO,
  memoryEnvelope,
  profilesEnvelope,
  runDetail,
  runEvents,
  runHealth,
  runsList,
} from "./fixtures";

export interface MockRequestRecord {
  method: string;
  path: string;
}

export interface MockApi {
  handle(request: Request): Response;
  requests(): readonly MockRequestRecord[];
}

type Match = Record<string, string>;
interface Route {
  method: string;
  pattern: RegExp;
  respond: (match: Match) => { status: number; body: unknown };
}

const NOT_FOUND = { status: 404, body: { error: "not found in mock lane" } };

const ROUTES: readonly Route[] = [
  { method: "GET", pattern: /^\/api\/health$/, respond: () => ok(HEALTH) },
  { method: "GET", pattern: /^\/api\/server-info$/, respond: () => ok(SERVER_INFO) },
  { method: "GET", pattern: /^\/api\/build$/, respond: () => ok(BUILD_INFO) },
  { method: "GET", pattern: /^\/api\/runs$/, respond: () => ok(runsList()) },
  {
    method: "GET",
    pattern: /^\/api\/runs\/(?<id>[A-Za-z0-9._-]+)$/,
    respond: ({ id }) => orNotFound(runDetail(id)),
  },
  {
    method: "GET",
    pattern: /^\/api\/runs\/(?<id>[A-Za-z0-9._-]+)\/health$/,
    respond: ({ id }) => orNotFound(runHealth(id)),
  },
  {
    method: "GET",
    pattern: /^\/api\/runs\/(?<id>[A-Za-z0-9._-]+)\/events$/,
    respond: ({ id }) => orNotFound(runEvents(id)),
  },
  { method: "GET", pattern: /^\/api\/active$/, respond: () => ok(ACTIVE_ENVELOPE) },
  { method: "GET", pattern: /^\/api\/health\/summary$/, respond: () => ok(HEALTH_SUMMARY) },
  { method: "GET", pattern: /^\/api\/harnesses$/, respond: () => ok(HARNESSES_ENVELOPE) },
  { method: "GET", pattern: /^\/api\/profiles$/, respond: () => ok(profilesEnvelope()) },
  { method: "GET", pattern: /^\/api\/memory$/, respond: () => ok(memoryEnvelope()) },
];

function ok(body: unknown): { status: number; body: unknown } {
  return { status: 200, body };
}

function orNotFound(body: unknown): { status: number; body: unknown } {
  return body === null ? NOT_FOUND : ok(body);
}

/**
 * Creates one isolated mock API. Each call has its own request log, so tests never share state.
 * Paths outside `/api/` and unknown `/api/` routes answer 404 with a JSON body, never a guess.
 */
export function createMockApi(): MockApi {
  const log: MockRequestRecord[] = [];
  return {
    handle(request: Request): Response {
      const url = new URL(request.url);
      log.push({ method: request.method, path: url.pathname });
      if (!url.pathname.startsWith("/api/")) {
        return json(NOT_FOUND);
      }
      for (const route of ROUTES) {
        if (route.method !== request.method) {
          continue;
        }
        const match = route.pattern.exec(url.pathname);
        if (match === null) {
          continue;
        }
        const groups = { ...(match.groups ?? {}) };
        return json(route.respond(groups));
      }
      return json(NOT_FOUND);
    },
    requests(): readonly MockRequestRecord[] {
      return [...log];
    },
  };
}

function json(result: { status: number; body: unknown }): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
