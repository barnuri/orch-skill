import { describe, expect, test } from "bun:test";

import { MAX_AUDIO_BYTES, MAX_AUDIO_REQUEST_BYTES, MAX_UPSTREAM_TIMEOUT_MS, MIN_UPSTREAM_TIMEOUT_MS, transcribe, upstreamTimeoutMs } from "./transcribe";

describe("transcribe limits", () => {
  test("the hub wait never drops below 2 minutes and grows with the clip up to 10 minutes", () => {
    expect(upstreamTimeoutMs(0)).toBe(MIN_UPSTREAM_TIMEOUT_MS);
    expect(upstreamTimeoutMs(30 * 32_000)).toBe(MIN_UPSTREAM_TIMEOUT_MS);
    expect(upstreamTimeoutMs(10 * 60 * 32_000)).toBeGreaterThan(MIN_UPSTREAM_TIMEOUT_MS);
    expect(upstreamTimeoutMs(MAX_AUDIO_BYTES)).toBe(MAX_UPSTREAM_TIMEOUT_MS);
    expect(upstreamTimeoutMs(-5)).toBe(MIN_UPSTREAM_TIMEOUT_MS);
  });

  test("the size limit holds ten minutes of 16 kHz wav, with room for the form framing", () => {
    expect(MAX_AUDIO_BYTES).toBeGreaterThan(10 * 60 * 32_000);
    expect(MAX_AUDIO_REQUEST_BYTES).toBeGreaterThan(MAX_AUDIO_BYTES);
  });

  test("a declared body over the cap is refused with 413 before it is read", async () => {
    const home = process.env.TMPDIR ?? "/tmp";
    const saved = { url: process.env.LLM_HUB_BASE_URL, key: process.env.LLM_HUB_API_KEY };
    process.env.LLM_HUB_BASE_URL = "http://127.0.0.1:1";
    process.env.LLM_HUB_API_KEY = "k";
    try {
      const req = new Request("http://x/api/voice/transcribe", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=a", "content-length": String(MAX_AUDIO_REQUEST_BYTES + 1) }, body: "x" });
      await expect(transcribe(home, req)).rejects.toMatchObject({ status: 413 });
    } finally {
      if (saved.url === undefined) delete process.env.LLM_HUB_BASE_URL; else process.env.LLM_HUB_BASE_URL = saved.url;
      if (saved.key === undefined) delete process.env.LLM_HUB_API_KEY; else process.env.LLM_HUB_API_KEY = saved.key;
    }
  });
});
