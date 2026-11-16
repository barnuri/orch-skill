import { Controller, Get, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { ServerInfoDto } from "../../../shared/dto/server-info";
import { jsonResponse } from "../../http/responses";
import { secureHostFor } from "../../tls/manager";
import type { ServerContext } from "../../types/server-context";
import type { ApiContext } from "../pipeline";

@Controller({ path: "/api", tags: ["server"] })
export class ServerInfoController {
  constructor(private readonly ctx: ServerContext) {}

  @Get("/server-info", {
    summary: "The optional HTTPS listener",
    description: "Reports whether the opt-in HTTPS port is listening and its secure link. The dashboard uses it only for a quiet hint; no link is built from it automatically.",
  })
  @ResponseSchema(ServerInfoDto.schema, { description: "HTTPS state." })
  get(c: ApiContext): Response {
    const status = this.ctx.tls?.status();
    const listening = status?.listening === true;
    const hostHeader = c.req.raw.headers.get("host") ?? this.ctx.hostname;
    const host = secureHostFor(status?.names ?? [], hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, ""));
    const bracket = host.includes(":") ? `[${host}]` : host;
    return jsonResponse(200, {
      https_port: this.ctx.httpsPort ?? 0,
      https_listening: listening,
      https_url: listening && status !== undefined ? `https://${bracket}:${status.port}/` : null,
      trust_path: listening && this.ctx.tls?.caPem() != null ? "/trust" : null,
      cert_source: status?.source ?? null,
      cert_expires: status?.not_after ?? null,
      problem: status?.problem ?? null,
      secure_link_hint: this.ctx.secureLinkHint !== false,
    });
  }
}
