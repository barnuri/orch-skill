import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

import { PUSH_CATEGORIES } from "../push";

const category = z.enum(PUSH_CATEGORIES);
const quiet = z.object({ enabled: z.boolean(), start: z.number().int().min(0).max(1439), end: z.number().int().min(0).max(1439), tz_offset: z.number().int().min(-840).max(840) });

@ZodObject({ description: "The server's VAPID public key (the `applicationServerKey` a browser subscribes with)." })
export class PushKeyDto extends ZodDto {
  @ZodField(z.string(), { description: "Uncompressed P-256 point, base64url." })
  public_key!: string;
}

@ZodObject({ description: "A browser push subscription, as `PushSubscription.toJSON()` returns it." })
export class PushSubscribeDto extends ZodDto {
  @ZodField(z.object({ endpoint: z.string().url().max(2048), keys: z.object({ p256dh: z.string().min(80).max(100), auth: z.string().min(16).max(40) }) }), { description: "The subscription." })
  subscription!: { endpoint: string; keys: { p256dh: string; auth: string } };

  @ZodField(z.string().max(80).optional(), { description: "A device label for the list." })
  label?: string;

  @ZodField(z.enum(["chat", "dashboard"]), { description: "Which installed app subscribed." })
  app!: "chat" | "dashboard";

  @ZodField(z.array(category).optional(), { description: "Categories to send; all when omitted." })
  categories?: (typeof PUSH_CATEGORIES)[number][];

  @ZodField(quiet.optional(), { description: "Quiet hours in minutes after local midnight." })
  quiet?: z.infer<typeof quiet>;
}

@ZodObject({ description: "Which subscription to drop." })
export class PushEndpointDto extends ZodDto {
  @ZodField(z.string().url().max(2048), { description: "The subscription endpoint." })
  endpoint!: string;
}

@ZodObject({ description: "Settings of one device." })
export class PushUpdateDto extends ZodDto {
  @ZodField(z.array(category).optional(), { description: "Categories to send." })
  categories?: (typeof PUSH_CATEGORIES)[number][];

  @ZodField(quiet.optional(), { description: "Quiet hours." })
  quiet?: z.infer<typeof quiet>;

  @ZodField(z.string().max(80).optional(), { description: "Device label." })
  label?: string;
}

@ZodObject({ description: "One subscribed device. Keys and the full endpoint are never listed." })
export class PushDeviceDto extends ZodDto {
  @ZodField(z.string(), { description: "Id." })
  id!: string;

  @ZodField(z.string(), { description: "Label." })
  label!: string;

  @ZodField(z.string(), { description: "User agent at subscribe time." })
  user_agent!: string;

  @ZodField(z.enum(["chat", "dashboard"]), { description: "Installed app." })
  app!: "chat" | "dashboard";

  @ZodField(z.string(), { description: "Host of the push service, for example fcm.googleapis.com." })
  service!: string;

  @ZodField(z.string(), { description: "ISO 8601." })
  created_at!: string;

  @ZodField(z.string().nullable(), { description: "Last accepted send." })
  last_success_at!: string | null;

  @ZodField(z.string().nullable(), { description: "Last failure, cleared by a success." })
  last_error!: string | null;

  @ZodField(z.array(category), { description: "Categories." })
  categories!: (typeof PUSH_CATEGORIES)[number][];

  @ZodField(quiet, { description: "Quiet hours." })
  quiet!: z.infer<typeof quiet>;
}

@ZodObject({ description: "All subscribed devices." })
export class PushDevicesDto extends ZodDto {
  @ZodField(z.array(PushDeviceDto.schema), { description: "Devices." })
  devices!: PushDeviceDto[];
}

@ZodObject({ description: "Device to test." })
export class PushTestDto extends ZodDto {
  @ZodField(z.string().max(64).optional(), { description: "Device id; with `endpoint` omitted." })
  id?: string;

  @ZodField(z.string().url().max(2048).optional(), { description: "Or the device's endpoint." })
  endpoint?: string;
}

@ZodObject({ description: "Result of a test push." })
export class PushTestResultDto extends ZodDto {
  @ZodField(z.boolean(), { description: "The push service accepted it." })
  ok!: boolean;

  @ZodField(z.number().int(), { description: "Push service status; 0 when unreachable." })
  status!: number;

  @ZodField(z.string().nullable(), { description: "Problem, if any." })
  error!: string | null;
}

@ZodObject({ description: "Whether a page is on screen." })
export class PushPresenceDto extends ZodDto {
  @ZodField(z.string().max(100).nullable(), { description: "The chat the page shows; null for the dashboard." })
  chat_id!: string | null;

  @ZodField(z.boolean(), { description: "document.visibilityState is visible." })
  visible!: boolean;

  @ZodField(z.boolean(), { description: "document.hasFocus()." })
  focused!: boolean;
}

@ZodObject({ description: "Chats waiting for the person." })
export class PushBadgeDto extends ZodDto {
  @ZodField(z.number().int(), { description: "Count for the app badge." })
  badge!: number;
}

@ZodObject({ description: "Whether a device was removed." })
export class PushRemovedDto extends ZodDto {
  @ZodField(z.boolean(), { description: "False when nothing was stored for it." })
  removed!: boolean;
}
