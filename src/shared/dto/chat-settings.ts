import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

import { CHAT_ROOT_MAX_LENGTH, CHAT_ROOTS_MAX, chatRootProblem, SCHEDULE_GRACE_MAX_HOURS } from "../chat-settings";

const root = z.string().max(CHAT_ROOT_MAX_LENGTH).superRefine((value, ctx) => {
  const why = chatRootProblem(value);
  if (why !== null) {
    ctx.addIssue({ code: "custom", message: why });
  }
});

@ZodObject({ description: "The chat settings kept in profiles.json under `settings`. Saved with PUT /api/profiles, which checks the same rules." })
export class ChatSettingsDto extends ZodDto {
  @ZodField(z.number().int().min(0).max(SCHEDULE_GRACE_MAX_HOURS).optional(), { description: "Hours a missed chat schedule may still run late after the server was off. Default 6. 0 skips every missed run." })
  schedule_grace_hours?: number;

  @ZodField(z.boolean().optional(), { description: "Let chat monitors check link-local addresses (169.254.x.x, fe80::), which include cloud metadata endpoints. Default off." })
  monitor_allow_link_local?: boolean;

  @ZodField(z.array(root).max(CHAT_ROOTS_MAX).optional(), { description: "Folders a chat may run in (absolute, or starting with `~/`). Default `~/sandbox/private`." })
  chat_roots?: string[];
}

@ZodObject({ description: "Whether the quiet 'open the secure link' hint may show. Kept in serve.json." })
export class SecureLinkHintDto extends ZodDto {
  @ZodField(z.boolean(), { description: "True shows the hint (default)." })
  secure_link_hint!: boolean;
}
