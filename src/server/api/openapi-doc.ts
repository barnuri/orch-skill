import { z } from "zod";

import * as active from "../../shared/dto/active";
import * as artifacts from "../../shared/dto/artifacts";
import * as browserProfiles from "../../shared/dto/browser-profiles";
import * as build from "../../shared/dto/build";
import * as chatAutomation from "../../shared/dto/chat-automation";
import * as chatQuestion from "../../shared/dto/chat-question";
import * as chatQueue from "../../shared/dto/chat-queue";
import * as chatSettings from "../../shared/dto/chat-settings";
import * as chats from "../../shared/dto/chats";
import * as common from "../../shared/dto/common";
import * as feedback from "../../shared/dto/feedback";
import * as push from "../../shared/dto/push";
import * as runHealth from "../../shared/dto/run-health";
import * as runs from "../../shared/dto/runs";
import * as schedule from "../../shared/dto/schedule";
import * as serverInfo from "../../shared/dto/server-info";
import * as skills from "../../shared/dto/skills";
import * as usage from "../../shared/dto/usage";
import * as voice from "../../shared/dto/voice";
import * as watchdog from "../../shared/dto/watchdog";
import * as workspace from "../../shared/dto/workspace";

const DTO_MODULES: readonly Record<string, unknown>[] = [
  active, artifacts, browserProfiles, build, chatAutomation, chatQuestion, chatQueue, chatSettings, chats, common,
  feedback, push, runHealth, runs, schedule, serverInfo, skills, usage, voice, watchdog, workspace,
];

let registered = false;

/**
 * Gives every exported `*Dto` class schema its class name as an OpenAPI id, so the document lists it once
 * in `components.schemas` and every route points at it with a `$ref`. Must run before the document is built.
 */
export function registerDtoSchemas(): void {
  if (registered) {
    return;
  }
  registered = true;
  const taken = new Set<string>();
  for (const mod of DTO_MODULES) {
    for (const [name, value] of Object.entries(mod)) {
      const schema = (value as { schema?: unknown } | undefined)?.schema;
      if (!name.endsWith("Dto") || !(schema instanceof z.ZodType) || taken.has(name)) {
        continue;
      }
      const meta = z.globalRegistry.get(schema) ?? {};
      if (meta["id"] !== undefined) {
        continue;
      }
      taken.add(name);
      z.globalRegistry.add(schema, { ...meta, id: name });
    }
  }
}

export const TAGS: readonly { name: string; description: string }[] = [
  { name: "runs", description: "Runs, their nodes, health, requirements and watchdog." },
  { name: "chats", description: "Chats, messages, events, attachments, questions and chat settings." },
  { name: "queue", description: "The per-chat message queue." },
  { name: "feedback", description: "Feedback items and the batch run that works on them." },
  { name: "skills", description: "Skills the composer can offer." },
  { name: "schedules", description: "Schedules, one-shot and recurring." },
  { name: "loops", description: "Loops and monitors, running or needing attention." },
  { name: "health", description: "Liveness of the server." },
];

export const SECURITY_SCHEME = "bearerAuth";

type Json = Record<string, unknown>;

/**
 * Routes whose handler reads the raw body itself (so a validating @Body would consume it first). Their
 * bodies are documented from the same DTO schemas here instead.
 */
const HAND_VALIDATED_BODIES: readonly { path: string; method: string; id: string; schema: z.ZodType; required: boolean }[] = [
  { path: "/api/feedback", method: "post", id: "FeedbackCreateDto", schema: feedback.FeedbackCreateDto.schema, required: true },
  { path: "/api/feedback/{id}", method: "patch", id: "FeedbackPatchDto", schema: feedback.FeedbackPatchDto.schema, required: true },
  { path: "/api/feedback/work", method: "post", id: "FeedbackWorkDto", schema: feedback.FeedbackWorkDto.schema, required: false },
];

function addBodies(doc: Json, schemas: Json): void {
  const paths = doc["paths"] as Record<string, Json>;
  for (const { path, method, id, schema, required } of HAND_VALIDATED_BODIES) {
    const op = paths[path]?.[method] as Json | undefined;
    if (op === undefined) {
      continue;
    }
    // The schema is registered under its id, so the generator answers with a `$ref` into `definitions`.
    const generated = z.toJSONSchema(schema, { target: "openapi-3.0", io: "input" }) as Json;
    schemas[id] ??= (generated["definitions"] as Json | undefined)?.[id] ?? generated;
    op["requestBody"] = {
      required,
      content: { "application/json": { schema: { $ref: `#/components/schemas/${id}` } } },
    };
  }
}
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch"] as const;

function errorResponse(description: string): Json {
  return { description, content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorDto" } } } };
}

/**
 * Adds what the controllers do not repeat per route: the auth scheme, the shared error responses
 * (400 bad Host or invalid request, 401 missing token, 500 internal) and the tag descriptions.
 */
export function augmentDocument(doc: Json): Json {
  const components = (doc["components"] ??= {}) as Json;
  const schemas = (components["schemas"] ??= {}) as Json;
  if (schemas["ErrorDto"] === undefined) {
    schemas["ErrorDto"] = { type: "object", properties: { error: { type: "string" } }, required: ["error"] };
  }
  components["securitySchemes"] = {
    [SECURITY_SCHEME]: {
      type: "http",
      scheme: "bearer",
      description:
        "`Authorization: Bearer <token>`, the token in `~/.harness-orch/serve.token`. A loopback peer needs no token when the server runs with `requireToken` off; a remote peer needs it unless `requireRemoteToken` is off. A bad `Host` header answers 400.",
    },
  };
  doc["security"] = [{ [SECURITY_SCHEME]: [] }];
  doc["tags"] = TAGS;
  const paths = (doc["paths"] ??= {}) as Record<string, Json>;
  paths["/api/openapi.json"] = {
    get: {
      summary: "This OpenAPI document",
      description: "The generated OpenAPI 3.0 document of the dashboard API. A committed copy is `docs/openapi.json` (`bun run openapi`).",
      tags: ["health"],
      responses: { "200": { description: "The document.", content: { "application/json": { schema: { type: "object" } } } } },
    },
  };
  paths["/api/docs"] = {
    get: {
      summary: "Interactive API docs",
      description: "A dependency-free HTML page that renders `/api/openapi.json`. It loads nothing from the internet.",
      tags: ["health"],
      responses: { "200": { description: "The page.", content: { "text/html": { schema: { type: "string" } } } } },
    },
  };
  addBodies(doc, schemas);
  for (const item of Object.values((doc["paths"] ?? {}) as Record<string, Json>)) {
    for (const method of HTTP_METHODS) {
      const op = item[method] as Json | undefined;
      if (op === undefined) {
        continue;
      }
      const responses = (op["responses"] ??= {}) as Json;
      responses["400"] ??= errorResponse("Bad Host header, or the request is invalid. `{ error }` names the field.");
      responses["401"] ??= errorResponse("Missing or wrong bearer token.");
      responses["500"] ??= errorResponse("Internal error. The stack goes to the server log only.");
    }
  }
  return doc;
}
