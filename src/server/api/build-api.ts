import { OpenAPIHono } from "@hono/zod-openapi";
import { registerController } from "@barnuri/hono-decorators";
import type { MiddlewareHandler } from "hono";

import type { ServerContext } from "../types/server-context";
import { ActiveController } from "./controllers/active.controller";
import { BuildController } from "./controllers/build.controller";
import { ChatsController } from "./controllers/chats.controller";
import { ChatQuestionsController } from "./controllers/chat-questions.controller";
import { ProjectsController } from "./controllers/projects.controller";
import { DocumentsController, HarnessesController } from "./controllers/documents.controller";
import { HealthController } from "./controllers/health.controller";
import { RunHealthController } from "./controllers/run-health.controller";
import { RunsController } from "./controllers/runs.controller";
import { SchedulesController } from "./controllers/schedules.controller";
import { SuggestionsController } from "./controllers/suggestions.controller";
import { WorkspaceController } from "./controllers/workspace.controller";
import { VoiceController } from "./controllers/voice.controller";
import { WatchdogController } from "./controllers/watchdog.controller";
import { type ApiEnv, guard, installFallbacks, validationHook } from "./pipeline";

export const OPENAPI_PATH: string = "/api/openapi.json";

/**
 * Every `/api/*` route, declared by decorated controllers. A controller method only delegates to
 * the handler that already served the route, so behavior is unchanged; what the decorators add is
 * routing, zod validation of the parts that have a schema, and an OpenAPI document generated from
 * the same declarations.
 */
export function buildApi(ctx: ServerContext): OpenAPIHono<ApiEnv> {
  const api = new OpenAPIHono<ApiEnv>({ strict: true, defaultHook: validationHook });
  const gate = guard(ctx) as unknown as MiddlewareHandler;
  const options = { middleware: [gate] };

  registerController(api, new HealthController(ctx), options);
  registerController(api, new ActiveController(ctx), options);
  registerController(api, new BuildController(ctx), options);
  registerController(api, new SchedulesController(ctx), options);
  registerController(api, new RunsController(ctx), options);
  registerController(api, new RunHealthController(ctx), options);
  registerController(api, new WatchdogController(ctx), options);
  registerController(api, new DocumentsController(ctx), options);
  registerController(api, new HarnessesController(ctx), options);
  registerController(api, new SuggestionsController(ctx), options);
  registerController(api, new ProjectsController(ctx), options);
  registerController(api, new ChatsController(ctx), options);
  registerController(api, new ChatQuestionsController(ctx), options);
  registerController(api, new WorkspaceController(ctx), options);
  registerController(api, new VoiceController(ctx), options);

  // The document describes the API's surface, so it asks for the same Host check and token as the API.
  api.use(OPENAPI_PATH, guard(ctx));
  api.doc(OPENAPI_PATH, {
    openapi: "3.0.0",
    info: {
      title: "orch dashboard API",
      version: "1.0.0",
      description: "The API behind the orch dashboard. Reads are cheap; writes go through `dispatch.ts`, the only writer of orch state.",
    },
  });
  installFallbacks(api, ctx);
  return api;
}
