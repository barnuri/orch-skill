import { z } from "zod";
import { ErrorDto } from "../../shared/dto/common";
import type { DocumentEnvelope } from "../../shared/types/document-envelope";
import type { ProfileSanityEnvelope } from "../../shared/types/profile-sanity";
import type { SuggestionApplyEnvelope } from "../../shared/types/suggestion-apply-envelope";

export const errorSchema = ErrorDto.schema;

const issue = z.object({ path: z.string(), reason: z.string() });

/**
 * The envelope of GET /api/{profiles,memory,suggestions}. The server's DTO leaves `document`
 * opaque (it is validated on write, never on read), so it stays `unknown` here and each page
 * narrows it with a guard, exactly as the vanilla dashboard did. The per-kind enum list
 * (`harnesses`, `kinds`, `outcomes`) is folded into `enums`.
 */
export interface LoadedEnvelope {
  document: unknown;
  issues: DocumentEnvelope<unknown>["issues"];
  limits: DocumentEnvelope<unknown>["limits"];
  enums: string[];
}

export const profilesEnvelopeSchema = z
  .object({
    document: z.unknown(),
    issues: z.array(issue),
    limits: z.object({ max_body_bytes: z.number() }),
    harnesses: z.array(z.string()),
  })
  .transform(({ harnesses, ...rest }): LoadedEnvelope => ({ ...rest, enums: harnesses }));

export const memoryEnvelopeSchema = z
  .object({
    document: z.unknown(),
    issues: z.array(issue),
    limits: z.object({ max_body_bytes: z.number() }),
    outcomes: z.array(z.string()),
  })
  .transform(({ outcomes, ...rest }): LoadedEnvelope => ({ ...rest, enums: outcomes }));

export const suggestionsEnvelopeSchema = z
  .object({
    document: z.unknown(),
    issues: z.array(issue),
    limits: z.object({ max_body_bytes: z.number() }),
    kinds: z.array(z.string()),
  })
  .transform(({ kinds, ...rest }): LoadedEnvelope => ({ ...rest, enums: kinds }));

// Annotated with the shared type, so tsc fails if the schema and the type drift apart.
export const sanitySchema: z.ZodType<ProfileSanityEnvelope> = z.object({
  generated_at: z.string(),
  results: z.array(
    z.object({
      profile: z.string(),
      ok: z.boolean(),
      status: z.enum(["ok", "failed", "unconfigured", "disabled", "unknown"]).optional(),
      ms: z.number(),
      harness: z.string(),
      model_id: z.string(),
      slug: z.string(),
      exit_code: z.number(),
      bytes: z.number(),
      error: z.string(),
    }),
  ),
});

export const suggestionApplySchema: z.ZodType<SuggestionApplyEnvelope> = z.object({
  ok: z.boolean(),
  applied: z.number(),
  failed: z.number(),
  results: z.array(z.object({ id: z.string(), ok: z.boolean(), error: z.string().optional() })),
});

export const putOkSchema = z.object({ ok: z.literal(true), etag: z.string() });
