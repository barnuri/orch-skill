// test-tier: slow (real ffmpeg process)
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_STT_MODELS, HEBREW_STT_MODEL, isAudioUpload, MAX_AUDIO_BYTES, modelOrder } from "./transcribe";

const FFMPEG: string | null = Bun.which("ffmpeg") ?? (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : null);

const KEY = "hub-secret-key-123";
const HUB_VARS = ["LLM_HUB_BASE_URL", "LLM_HUB_V1_URL", "LLM_HUB_URL", "LLM_HUB_API_KEY", "LLM_HUB_KEY", "ORCH_STT_MODEL"];
const saved: Record<string, string | undefined> = {};

interface Seen {
  auth: string | null;
  model: string;
  filename: string;
  size: number;
  language: string | null;
}

let hub: Server<undefined>;
const seen: Seen[] = [];

beforeAll(() => {
  for (const name of HUB_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  // A fake LLM hub: `broken/*` fails like the real whisper-server when ffmpeg cannot run; `leaky/*` echoes the key back.
  hub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const form = await req.formData();
      const file = form.get("file") as File;
      const model = String(form.get("model"));
      const lang = form.get("language");
      seen.push({ auth: req.headers.get("authorization"), model, filename: file.name, size: file.size, language: typeof lang === "string" ? lang : null });
      if (model.startsWith("broken/")) {
        return Response.json({ error: "FFmpeg conversion failed." }, { status: 500 });
      }
      if (model.startsWith("wavonly/") && !file.name.endsWith(".wav")) {
        return new Response("Internal Server Error", { status: 500 });
      }
      if (model.startsWith("leaky/")) {
        return Response.json({ error: { message: `bad key ${KEY}` } }, { status: 401 });
      }
      return Response.json({ text: `  heard ${file.name}  ` });
    },
  });
});

afterAll(() => {
  void hub.stop(true);
  for (const name of HUB_VARS) {
    if (saved[name] !== undefined) {
      process.env[name] = saved[name];
    }
  }
});

const servers: TestServerHandle[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.stop();
  }
  seen.length = 0;
});

function server(env: string | null = `LLM_HUB_BASE_URL=http://127.0.0.1:${hub.port}/v1/\nLLM_HUB_API_KEY=${KEY}\n`): TestServerHandle {
  const srv = startTestServer();
  if (env !== null) {
    srv.home.write("env", env);
  }
  servers.push(srv);
  return srv;
}

function clip(name: string, type: string, bytes: number = 2048, extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes).fill(7)], name, { type }));
  for (const [k, v] of Object.entries(extra)) {
    form.append(k, v);
  }
  return form;
}

const post = (srv: TestServerHandle, body: BodyInit, headers: Record<string, string> = {}, auth: boolean = true): Promise<Response> =>
  srv.api("/api/voice/transcribe", { method: "POST", body, headers }, auth);

describe("POST /api/voice/transcribe", () => {
  test("forwards webm (Chrome) and mp4 (Safari) clips to whisper with the hub key and answers the trimmed text", async () => {
    const srv = server();
    for (const [name, type] of [["voice.webm", "audio/webm;codecs=opus"], ["voice.mp4", "audio/mp4"]] as const) {
      const res = await post(srv, clip(name, type, 4096, { language: "en" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ text: `heard ${name}`, model: "whisper/whisper-large-v3" });
    }
    expect(seen.map((s) => [s.auth, s.model, s.filename, s.size, s.language])).toEqual([
      [`Bearer ${KEY}`, "whisper/whisper-large-v3", "voice.webm", 4096, "en"],
      [`Bearer ${KEY}`, "whisper/whisper-large-v3", "voice.mp4", 4096, "en"],
    ]);
  });

  test("default order is whisper then parakeet; a Hebrew hint tries the Hebrew model first; no wav retry before a failure", async () => {
    const srv = server(`LLM_HUB_BASE_URL=http://127.0.0.1:${hub.port}/v1\nLLM_HUB_API_KEY=${KEY}\n`);
    const he = await post(srv, clip("a.m4a", "audio/mp4", 2048, { language: "he" }));
    expect(await he.json()).toEqual({ text: "heard a.m4a", model: HEBREW_STT_MODEL });
    const en = await post(srv, clip("b.webm", "audio/webm", 2048, { language: "en" }));
    expect(await en.json()).toEqual({ text: "heard b.webm", model: "whisper/whisper-large-v3" });
    expect(seen.map((s) => [s.model, s.filename])).toEqual([[HEBREW_STT_MODEL, "a.m4a"], ["whisper/whisper-large-v3", "b.webm"]]);
  });

  test("a Hebrew hint goes first even when ORCH_STT_MODEL overrides the list", async () => {
    const srv = server(`LLM_HUB_BASE_URL=http://127.0.0.1:${hub.port}/v1\nLLM_HUB_API_KEY=${KEY}\nORCH_STT_MODEL=good/whisper\n`);
    const res = await post(srv, clip("a.webm", "audio/webm", 2048, { language: "he" }));
    expect(await res.json()).toEqual({ text: "heard a.webm", model: HEBREW_STT_MODEL });
  });

  test("asks for the token like every /api route", async () => {
    const srv = server();
    expect((await post(srv, clip("a.webm", "audio/webm"), {}, false)).status).toBe(401);
    expect(seen).toEqual([]);
  });

  test("refuses a missing, empty, non-audio or oversized file before calling the hub", async () => {
    const srv = server();
    const none = new FormData();
    none.append("language", "en");
    expect((await post(srv, none)).status).toBe(400);
    expect((await post(srv, clip("a.webm", "audio/webm", 0))).status).toBe(400);
    expect((await post(srv, clip("notes.txt", "text/plain"))).status).toBe(415);
    expect((await post(srv, JSON.stringify({ file: "x" }), { "Content-Type": "application/json" })).status).toBe(415);
    const big = await post(srv, clip("big.webm", "audio/webm", MAX_AUDIO_BYTES + 1));
    expect(big.status).toBe(413);
    expect(seen).toEqual([]);
  });

  test("503 when the hub is not configured", async () => {
    const res = await post(server(null), clip("a.webm", "audio/webm"));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("LLM_HUB_BASE_URL");
  });

  test("a hub failure is a 502 with its message; ORCH_STT_MODEL fallbacks are tried in order", async () => {
    const failing = await post(server(`LLM_HUB_BASE_URL=http://127.0.0.1:${hub.port}/v1\nLLM_HUB_API_KEY=${KEY}\nORCH_STT_MODEL=broken/whisper\n`), clip("a.webm", "audio/webm"));
    expect(failing.status).toBe(502);
    expect(((await failing.json()) as { error: string }).error).toContain("broken/whisper: FFmpeg conversion failed.");
    const rescued = await post(server(`LLM_HUB_BASE_URL=http://127.0.0.1:${hub.port}/v1\nLLM_HUB_API_KEY=${KEY}\nORCH_STT_MODEL=broken/whisper, good/parakeet\n`), clip("a.m4a", "audio/mp4"));
    expect(await rescued.json()).toEqual({ text: "heard a.m4a", model: "good/parakeet" });
  });

  test.skipIf(FFMPEG === null)("a clip the model cannot decode (Safari mp4) is retried once as 16 kHz wav", async () => {
    const srv = server(`LLM_HUB_BASE_URL=http://127.0.0.1:${hub.port}/v1\nLLM_HUB_API_KEY=${KEY}\nORCH_STT_MODEL=wavonly/parakeet\n`);
    const m4a = join(srv.home.path, "tone.m4a");
    expect(Bun.spawnSync([FFMPEG as string, "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", "-c:a", "aac", m4a]).exitCode).toBe(0);
    const form = new FormData();
    form.append("file", new File([await Bun.file(m4a).arrayBuffer()], "voice.mp4", { type: "audio/mp4" }));
    const res = await post(srv, form);
    expect(await res.json()).toEqual({ text: "heard voice.wav", model: "wavonly/parakeet" });
    expect(seen.map((x) => x.filename)).toEqual(["voice.mp4", "voice.wav"]);
    expect(seen[1]?.size).toBeGreaterThan(44);
  });

  test("never echoes the hub key, even when the hub does", async () => {
    const res = await post(server(`LLM_HUB_BASE_URL=http://127.0.0.1:${hub.port}/v1\nLLM_HUB_API_KEY=${KEY}\nORCH_STT_MODEL=leaky/x\n`), clip("a.webm", "audio/webm"));
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text).not.toContain(KEY);
    expect(text).toContain("***");
  });

  test("an unreachable hub is a 502, not a 500", async () => {
    const res = await post(server(`LLM_HUB_BASE_URL=http://127.0.0.1:9/v1\nLLM_HUB_API_KEY=${KEY}\n`), clip("a.webm", "audio/webm"));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("unreachable");
  });

  test("the OpenAPI document lists the route", async () => {
    const doc = (await (await server().api("/api/openapi.json")).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toContain("/api/voice/transcribe");
  });
});

describe("modelOrder", () => {
  test("defaults put whisper first and parakeet last", () => {
    expect(DEFAULT_STT_MODELS[0]).toBe("whisper/whisper-large-v3");
    expect(DEFAULT_STT_MODELS[DEFAULT_STT_MODELS.length - 1]).toMatch(/^parakeet\//);
  });

  test("only a Hebrew hint (he or iw) moves the Hebrew model to the front, once", () => {
    const list = ["whisper/whisper-large-v3", "parakeet/p"];
    expect(modelOrder(list, null)).toEqual(list);
    expect(modelOrder(list, "en")).toEqual(list);
    expect(modelOrder(list, "he")).toEqual([HEBREW_STT_MODEL, ...list]);
    expect(modelOrder(list, "iw")).toEqual([HEBREW_STT_MODEL, ...list]);
    expect(modelOrder(["a", HEBREW_STT_MODEL, "b"], "he")).toEqual([HEBREW_STT_MODEL, "a", "b"]);
  });
});

describe("isAudioUpload", () => {
  test("accepts browser recordings and audio files, refuses the rest", () => {
    expect(isAudioUpload("x.webm", "audio/webm;codecs=opus")).toBe(true);
    expect(isAudioUpload("x.mp4", "audio/mp4")).toBe(true);
    expect(isAudioUpload("x.mp4", "video/mp4")).toBe(true);
    expect(isAudioUpload("jfk.wav", "")).toBe(true);
    expect(isAudioUpload("clip", "application/octet-stream")).toBe(false);
    expect(isAudioUpload("a.png", "image/png")).toBe(false);
  });
});
