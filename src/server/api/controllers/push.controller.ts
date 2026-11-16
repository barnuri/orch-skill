import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { ChatIdParamsDto } from "../../../shared/dto/chats";
import { ErrorDto } from "../../../shared/dto/common";
import { PushBadgeDto, PushDevicesDto, PushEndpointDto, PushKeyDto, PushPresenceDto, PushRemovedDto, PushSubscribeDto, PushTestDto, PushTestResultDto, PushUpdateDto, PushDeviceDto } from "../../../shared/dto/push";
import { jsonResponse } from "../../http/responses";
import { chatServiceFor } from "../../chats/service";
import { attachChatPush } from "../../push/chat-hook";
import { type PushHub, pushHubFor } from "../../push/hub";
import { endpointAllowed } from "../../push/webpush";
import { subscriptionId, type Subscription } from "../../push/store";
import type { ServerContext } from "../../types/server-context";
import type { ApiContext } from "../pipeline";
import { valid } from "./support";

export function publicDevice(s: Subscription): Record<string, unknown> {
  let service = "";
  try {
    service = new URL(s.endpoint).host;
  } catch {
    // keep empty
  }
  return { id: s.id, label: s.label, user_agent: s.user_agent, app: s.app, service, created_at: s.created_at, last_success_at: s.last_success_at, last_error: s.last_error, categories: s.categories, quiet: s.quiet };
}

@Controller({ path: "/api/push", tags: ["push"] })
export class PushController {
  private readonly hub: PushHub;

  constructor(ctx: ServerContext) {
    this.hub = pushHubFor(ctx.paths.home);
    this.hub.attachOnce(() => attachChatPush(chatServiceFor(ctx), this.hub));
  }

  @Get("/key", { summary: "VAPID public key", description: "The key a browser passes as `applicationServerKey`. The private key stays in `<orch home>/push/vapid.json` and is never served. Push itself works only on https or localhost." })
  @ResponseSchema(PushKeyDto.schema, { description: "The public key." })
  async key(): Promise<Response> {
    return jsonResponse(200, { public_key: (await this.hub.vapid()).public_key });
  }

  @Post("/subscribe", { summary: "Store a push subscription", description: "Same endpoint again updates the device in place. Notifications go only to the browser push service named in the endpoint." })
  @Body(PushSubscribeDto.schema)
  @ResponseSchema(PushDeviceDto.schema, { status: 201, description: "The device." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "The endpoint is not a push service." })
  subscribe(c: ApiContext): Response {
    const body = valid<{ subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; label?: string; app: "chat" | "dashboard"; categories?: Subscription["categories"]; quiet?: Subscription["quiet"] }>(c, "json");
    if (!endpointAllowed(body.subscription.endpoint)) return jsonResponse(400, { error: "endpoint: must be an https push service" });
    const sub = this.hub.store.upsert({
      endpoint: body.subscription.endpoint,
      p256dh: body.subscription.keys.p256dh,
      auth: body.subscription.keys.auth,
      label: body.label ?? "This device",
      user_agent: c.req.header("user-agent") ?? "",
      app: body.app,
      ...(body.categories === undefined ? {} : { categories: body.categories }),
      ...(body.quiet === undefined ? {} : { quiet: body.quiet }),
    });
    return jsonResponse(201, publicDevice(sub));
  }

  @Delete("/subscribe", { summary: "Drop a push subscription by endpoint", description: "Answers 200 whether or not the endpoint was stored." })
  @Query(PushEndpointDto.schema)
  @ResponseSchema(PushRemovedDto.schema, { description: "Result." })
  unsubscribe(c: ApiContext): Response {
    return jsonResponse(200, { removed: this.hub.store.remove(subscriptionId(valid<{ endpoint: string }>(c, "query").endpoint)) });
  }

  @Get("/subscriptions", { summary: "List subscribed devices", description: "Label, app, categories and last result. Endpoints and keys are not listed." })
  @ResponseSchema(PushDevicesDto.schema, { description: "Devices." })
  list(): Response {
    return jsonResponse(200, { devices: this.hub.store.list().map(publicDevice) });
  }

  @Patch("/subscriptions/{id}", { summary: "Change a device's categories, quiet hours or label" })
  @Param(ChatIdParamsDto.schema)
  @Body(PushUpdateDto.schema)
  @ResponseSchema(PushDeviceDto.schema, { description: "The device." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such device." })
  update(c: ApiContext): Response {
    const patch = valid<Partial<Pick<Subscription, "categories" | "quiet" | "label">>>(c, "json");
    const next = this.hub.store.update(c.req.param("id") as string, patch);
    return next === null ? jsonResponse(404, { error: "no such device" }) : jsonResponse(200, publicDevice(next));
  }

  @Delete("/subscriptions/{id}", { summary: "Remove a device" })
  @Param(ChatIdParamsDto.schema)
  @ResponseSchema(PushRemovedDto.schema, { description: "Removed." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such device." })
  remove(c: ApiContext): Response {
    return this.hub.store.remove(c.req.param("id") as string) ? jsonResponse(200, { removed: true }) : jsonResponse(404, { error: "no such device" });
  }

  @Post("/test", { summary: "Send a test notification to one device", description: "Ignores the category and quiet-hours settings. A 404 or 410 from the push service removes the device." })
  @Body(PushTestDto.schema)
  @ResponseSchema(PushTestResultDto.schema, { description: "What the push service answered." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such device." })
  async test(c: ApiContext): Promise<Response> {
    const body = valid<{ id?: string; endpoint?: string }>(c, "json");
    const id = body.id ?? (body.endpoint === undefined ? "" : subscriptionId(body.endpoint));
    const res = await this.hub.test(id);
    if (res === null) return jsonResponse(404, { error: "no such device" });
    return jsonResponse(200, { ok: res.ok, status: res.status, error: res.ok ? null : res.error });
  }

  @Post("/presence", { summary: "Report that a chat is on screen", description: "A page sends this every 2 s while it is visible and focused. For 3 s after the last one the server sends no notification for that chat, and the chat leaves the badge count." })
  @Body(PushPresenceDto.schema)
  @ResponseSchema(PushBadgeDto.schema, { description: "Chats still waiting." })
  presence(c: ApiContext): Response {
    const b = valid<{ chat_id: string | null; visible: boolean; focused: boolean }>(c, "json");
    this.hub.presence(b.chat_id, b.visible, b.focused);
    return jsonResponse(200, { badge: this.hub.badge() });
  }
}
