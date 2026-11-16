import { describe, expect, test } from "bun:test";
import type { Message } from "./chat-types";
import {
  appendTranscript, detectLanguage, finishedReplyAfter, formatElapsed, lastAssistantId, micErrorMessage, pickRecorderMime, pickVoice,
  recordingFilename, rmsLevel, SilenceDetector, speakableText, speechChunks, transcribeLanguage,
} from "./voice-logic";

const msg = (id: string, over: Partial<Message> = {}): Message => ({ id, chat_id: "c", role: "assistant", content: "hi", status: "done", error: null, model_used: null, input_tokens: 0, output_tokens: 0, cost_usd: null, started_at: null, finished_at: null, created_at: "", attachments: [], ...over });

describe("recorder format", () => {
  test("Chrome gets webm/opus, Safari mp4, and the filename extension follows the container", () => {
    const chrome = (t: string) => t.startsWith("audio/webm");
    const safari = (t: string) => t.startsWith("audio/mp4");
    expect(pickRecorderMime(chrome)).toBe("audio/webm;codecs=opus");
    expect(pickRecorderMime(safari)).toBe("audio/mp4;codecs=mp4a.40.2");
    expect(pickRecorderMime(() => false)).toBe("");
    expect(pickRecorderMime(() => { throw new Error("unknown"); })).toBe("");
    expect(recordingFilename("audio/webm;codecs=opus")).toBe("voice.webm");
    expect(recordingFilename("audio/mp4")).toBe("voice.mp4");
    expect(recordingFilename("audio/mp4;codecs=mp4a.40.2")).toBe("voice.mp4");
    expect(recordingFilename("audio/ogg;codecs=opus")).toBe("voice.ogg");
    expect(recordingFilename("")).toBe("voice.webm");
  });

  test("elapsed clock", () => {
    expect([formatElapsed(0), formatElapsed(5_400), formatElapsed(65_000), formatElapsed(-3)]).toEqual(["0:00", "0:05", "1:05", "0:00"]);
  });
});

describe("end of speech", () => {
  test("rms of a silent frame is 0, of a loud one is high", () => {
    expect(rmsLevel(new Uint8Array(64).fill(128))).toBe(0);
    expect(rmsLevel(Uint8Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? 0 : 255)))).toBeGreaterThan(0.9);
  });

  test("ends 1.2 s after speech, never on leading silence, ignores a short click", () => {
    const d = new SilenceDetector({ threshold: 0.02, silenceMs: 1200, minSpeechMs: 250 });
    const events: Array<[number, string]> = [];
    const feed = (level: number, from: number, to: number): void => {
      for (let t = from; t < to; t += 50) {
        const e = d.push(level, t);
        if (e !== null) events.push([t, e]);
      }
    };
    feed(0, 0, 3000); // long silence first: nothing
    feed(0.5, 3000, 3100); // a click
    feed(0, 3100, 5000);
    expect(events).toEqual([]);
    feed(0.3, 5000, 6000); // speech
    feed(0.005, 6000, 6500); // a pause shorter than 1.2 s
    feed(0.3, 6500, 7000);
    feed(0, 7000, 9000);
    expect(events).toEqual([[5250, "speech-start"], [8200, "speech-end"]]);
    expect(d.heardSpeech).toBe(true);
  });
});

describe("read aloud", () => {
  test("language by script: Hebrew, Russian, English; the browser language otherwise", () => {
    expect(detectLanguage("שלום, מה שלומך היום?", "en-US")).toBe("he-IL");
    expect(detectLanguage("Привет, как дела?", "en-US")).toBe("ru-RU");
    expect(detectLanguage("Hello there, how are you?", "he-IL")).toBe("en-US");
    expect(detectLanguage("Bonjour à tous", "fr-FR")).toBe("fr-FR");
    expect(detectLanguage("1234 !!", "de-DE")).toBe("de-DE");
  });

  test("voice: exact tag, then same language (iw is Hebrew), default first", () => {
    const voices = [
      { name: "Alex", lang: "en-US", default: true },
      { name: "Daniel", lang: "en-GB" },
      { name: "Carmit", lang: "he-IL" },
      { name: "Old", lang: "iw_IL" },
    ];
    expect(pickVoice(voices, "he-IL")?.name).toBe("Carmit");
    expect(pickVoice(voices.filter((v) => v.name !== "Carmit"), "he-IL")?.name).toBe("Old");
    expect(pickVoice(voices, "en-AU")?.name).toBe("Alex");
    expect(pickVoice(voices, "ja-JP")).toBeNull();
  });

  test("markdown becomes plain speech; long text is cut at sentence ends", () => {
    expect(speakableText("# Title\n\n**Bold** and `x` see [docs](http://a.b).\n\n```ts\nconst a = 1;\n```\n- item")).toBe("Title Bold and x see docs. (code) item");
    const long = `${"One sentence here. ".repeat(30)}`;
    const chunks = speechChunks(long, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(long.trim());
    expect(speechChunks("a ".repeat(300), 50).every((c) => c.length <= 50)).toBe(true);
    expect(speechChunks("")).toEqual([]);
  });
});

describe("conversation turn", () => {
  test("waits for an assistant reply newer than the one before sending, until it finished", () => {
    const old = msg("msg-01");
    expect(lastAssistantId([old, msg("msg-02", { role: "user" })])).toBe("msg-01");
    expect(finishedReplyAfter([old], "msg-01")).toBeNull();
    expect(finishedReplyAfter([old, msg("msg-03", { status: "streaming" })], "msg-01")).toBeNull();
    expect(finishedReplyAfter([old, msg("msg-03", { status: "done", content: "yes" })], "msg-01")?.content).toBe("yes");
    expect(finishedReplyAfter([msg("msg-03", { status: "error" })], null)?.status).toBe("error");
  });

  test("the transcription hint is the last reply's language, else the browser's, as two letters", () => {
    expect(transcribeLanguage([], "he-IL")).toBe("he");
    expect(transcribeLanguage([], "iw")).toBe("he");
    expect(transcribeLanguage([], "en-US")).toBe("en");
    expect(transcribeLanguage([], "")).toBeNull();
    expect(transcribeLanguage([msg("msg-01", { content: "Hello there, how are you?" }), msg("msg-02", { content: "שלום, מה שלומך היום?" })], "en-US")).toBe("he");
    expect(transcribeLanguage([msg("msg-02", { content: "שלום" }), msg("msg-03", { content: "Fine, thanks for asking" })], "he-IL")).toBe("en");
    expect(transcribeLanguage([msg("msg-01", { role: "user", content: "שלום" })], "en-US")).toBe("en");
  });

  test("transcript joins the draft with one space", () => {
    expect([appendTranscript("", " hi "), appendTranscript("draft", "more"), appendTranscript("draft ", "more"), appendTranscript("x", "  ")]).toEqual(["hi", "draft more", "draft more", "x"]);
  });

  test("mic errors say what to do", () => {
    expect(micErrorMessage({ name: "NotAllowedError" })).toContain("permission was denied");
    expect(micErrorMessage({ name: "NotFoundError" })).toBe("No microphone was found.");
    expect(micErrorMessage(new Error("boom"))).toContain("boom");
  });
});
