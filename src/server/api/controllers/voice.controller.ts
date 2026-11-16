import { Controller, Post, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { ErrorDto } from "../../../shared/dto/common";
import { TranscriptDto } from "../../../shared/dto/voice";
import { TranscribeError, transcribe } from "../../chats/transcribe";
import { jsonResponse } from "../../http/responses";
import type { ServerContext } from "../../types/server-context";
import type { ApiContext } from "../pipeline";
import { failure } from "./projects.controller";

@Controller({ path: "/api", tags: ["voice"] })
export class VoiceController {
  constructor(private readonly ctx: ServerContext) {}

  @Post("/voice/transcribe", {
    summary: "Speech to text",
    description: "Send `multipart/form-data` with a `file` field holding one recorded clip (webm, mp4/m4a, wav, ogg, mp3…; 25 MB at most) and an optional two-letter `language`. The server forwards it to the LLM hub's `/audio/transcriptions` (models tried in order: `whisper/whisper-large-v3`, then parakeet, or the comma-separated list in ORCH_STT_MODEL; a `he` hint puts `ivrit/ivrit-large-v3-turbo` first) and answers the text. Nothing is stored. 503 when the hub is not configured, 502 when it failed.",
  })
  @ResponseSchema(TranscriptDto.schema, { description: "The text." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "No file or an empty one." })
  @ResponseSchema(ErrorDto.schema, { status: 413, description: "Larger than 25 MB." })
  @ResponseSchema(ErrorDto.schema, { status: 415, description: "Not multipart, or not audio." })
  @ResponseSchema(ErrorDto.schema, { status: 502, description: "The hub could not transcribe it." })
  @ResponseSchema(ErrorDto.schema, { status: 503, description: "The hub is not configured." })
  async transcribe(c: ApiContext): Promise<Response> {
    try {
      return jsonResponse(200, await transcribe(this.ctx.paths.home, c.req.raw));
    } catch (err) {
      if (err instanceof TranscribeError) {
        return jsonResponse(err.status, { error: err.message });
      }
      return failure(err);
    }
  }
}
