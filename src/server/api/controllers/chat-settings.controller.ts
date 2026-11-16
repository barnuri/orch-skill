import { Body, Controller, Put, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { SecureLinkHintDto } from "../../../shared/dto/chat-settings";
import { ErrorDto } from "../../../shared/dto/common";
import { dispatchPath } from "../../dispatch-path";
import { jsonResponse } from "../../http/responses";
import type { ServerContext } from "../../types/server-context";
import type { ApiContext } from "../pipeline";
import { valid } from "./support";

/** The Settings fields that do not live in profiles.json. The rest of the chat settings are saved with PUT /api/profiles. */
@Controller({ path: "/api", tags: ["chats"] })
export class ChatSettingsController {
  constructor(private readonly ctx: ServerContext) {}

  @Put("/chat-settings/secure-link-hint", {
    summary: "Show or hide the secure-link hint",
    description: "Sets `secure_link_hint` in serve.json through `dispatch serve config`, and applies it to the running server at once (GET /api/server-info reports it). The profiles-based chat settings (`chat_roots`, `schedule_grace_hours`, `monitor_allow_link_local`) are saved with PUT /api/profiles.",
  })
  @Body(SecureLinkHintDto.schema)
  @ResponseSchema(SecureLinkHintDto.schema, { description: "The value now in force." })
  @ResponseSchema(ErrorDto.schema, { status: 500, description: "serve.json could not be written." })
  async setSecureLinkHint(c: ApiContext): Promise<Response> {
    const { secure_link_hint: value } = valid<{ secure_link_hint: boolean }>(c, "json");
    const proc = Bun.spawn([process.execPath, dispatchPath(), "serve", "config", "secure_link_hint", String(value)], {
      env: { ...process.env, HARNESS_ORCH_HOME: this.ctx.paths.home }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) {
      return jsonResponse(500, { error: `could not save the setting: ${err.trim().split("\n")[0] ?? `exit ${code}`}` });
    }
    this.ctx.secureLinkHint = value;
    return jsonResponse(200, { secure_link_hint: value });
  }
}
