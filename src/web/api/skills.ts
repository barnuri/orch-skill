import { z } from "zod";
import type { SkillSuggestion } from "../../shared/slash-commands";
import { API_BASE } from "../lib/constants";
import { api } from "./client";
import type { ApiResult } from "./result";

const skillsSchema = z.object({ skills: z.array(z.object({ name: z.string(), description: z.string() })) });

export const skillsApi = {
  list: (): Promise<ApiResult<{ skills: SkillSuggestion[] }>> => api.request("GET", `${API_BASE}/skills`, skillsSchema, { quiet: true }),
};
