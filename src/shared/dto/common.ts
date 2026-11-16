import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

@ZodObject({ description: "Every failed request answers with this shape." })
export class ErrorDto extends ZodDto {
  @ZodField(z.string(), { description: "What went wrong, in one sentence. Never a stack trace." })
  error!: string;
}

@ZodObject({ description: "A mutation that succeeded." })
export class OkDto extends ZodDto {
  @ZodField(z.boolean(), { description: "Always true; failures use ErrorDto." })
  ok!: boolean;

  @ZodField(z.string().optional(), { description: "What `dispatch.ts` printed, when it printed anything." })
  output?: string;
}

@ZodObject({ description: "Liveness of the dashboard server." })
export class HealthDto extends ZodDto {
  @ZodField(z.boolean(), { description: "Always true when the server answers." })
  ok!: boolean;

  @ZodField(z.number().int(), { description: "Process id of the server." })
  pid!: number;

  @ZodField(z.string(), { description: "The orch state directory the server reads." })
  home!: string;

  @ZodField(z.string(), { description: "Bun version running the server." })
  version!: string;
}

@ZodObject({ description: "A JSON document whose shape is documented in references/state-and-config.md." })
export class OpaqueDocumentDto extends ZodDto {
  @ZodField(z.record(z.string(), z.unknown()).optional(), { description: "The document. Validated on write, never on read." })
  document?: Record<string, unknown>;
}

export const OpaqueObject = z.record(z.string(), z.unknown()).describe("A JSON object; see references/state-and-config.md.");
