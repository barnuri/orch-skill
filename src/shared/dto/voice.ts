import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

@ZodObject({ description: "What a recorded clip said. The audio is not kept." })
export class TranscriptDto extends ZodDto {
  @ZodField(z.string(), { description: "The transcribed text, trimmed. Empty when nothing was said." })
  text!: string;

  @ZodField(z.string(), { description: "The LLM hub model that transcribed it." })
  model!: string;
}
