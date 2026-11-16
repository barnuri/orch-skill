import type { z } from "zod";
import { SecureLinkHintDto } from "../../shared/dto/chat-settings";
import { API_BASE } from "../lib/constants";
import { api } from "./client";
import type { ApiResult } from "./result";

const hintSchema = SecureLinkHintDto.schema as unknown as z.ZodType<{ secure_link_hint: boolean }>;

export const chatSettingsApi = {
  setSecureLinkHint: (value: boolean): Promise<ApiResult<{ secure_link_hint: boolean }>> =>
    api.request("PUT", `${API_BASE}/chat-settings/secure-link-hint`, hintSchema, { body: { secure_link_hint: value } }),
};
