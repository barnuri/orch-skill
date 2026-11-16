import { afterAll, describe, expect, test } from "bun:test";
import { useState } from "react";
import { installDom } from "../test/dom";
import type { Message } from "../lib/chat-types";
import type { RecordOptions } from "./voice";
import type { ConversationQuestion, VoiceDeps } from "./use-voice";
import type { TtsHandlers } from "./voice";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, act } = await import("@testing-library/react");
const { Composer } = await import("./Composer");
const { useVoiceConversation } = await import("./use-voice");
const { transcribeClip } = await import("./voice");

afterAll(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 100));
  uninstall();
});

const store = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) } as unknown as Storage;
};
const msg = (id: string, over: Partial<Message> = {}): Message => ({ id, chat_id: "c", role: "assistant", content: "", status: "done", error: null, model_used: null, input_tokens: 0, output_tokens: 0, cost_usd: null, started_at: null, finished_at: null, created_at: "", attachments: [], ...over });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** Fake microphone, recorder, transcriber and speech, with a log of what happened. */
function fakeVoice(over: Partial<VoiceDeps> = {}) {
  const log: string[] = [];
  const recorders: RecordOptions[] = [];
  let ttsHandlers: TtsHandlers | null = null;
  const deps: VoiceDeps = {
    openMic: async () => { log.push("open"); return { getTracks: () => [] } as unknown as MediaStream; },
    closeMic: () => { log.push("close"); },
    record: (_s, o) => {
      recorders.push(o);
      log.push("record");
      return {
        heardSpeech: true,
        stop: async () => { log.push("stop"); o.onSegment?.({ blob: new Blob(["x"], { type: "audio/mp4" }), mime: "audio/mp4", seconds: 2, hadSpeech: true, overlapped: false }); },
        cancel: () => { log.push("cancel"); },
      };
    },
    transcribe: async (_b, mime) => { log.push(`transcribe ${mime}`); return { ok: true, text: "hello world" }; },
    makeTts: (h) => {
      ttsHandlers = h;
      let n = 0;
      return {
        enqueue: (s) => { log.push(`say ${s.text}`); if (n++ === 0) h.onStart(); h.onActive(s); },
        stop: () => { log.push("tts-stop"); n = 0; },
        speaking: false,
      };
    },
    speak: async () => undefined,
    stopSpeaking: () => { log.push("stopSpeaking"); },
    primeSpeech: () => { log.push("prime"); },
    wakeLock: { acquire: async () => { log.push("wake-lock"); return true; }, reacquire: async () => undefined, release: async () => { log.push("wake-release"); } },
    origin: () => null,
    storage: () => store(),
    ...over,
  };
  const last = () => recorders[recorders.length - 1] as RecordOptions;
  return { deps, log, recorders, speechEnd: () => last().onSpeechEnd?.(), speechStart: () => last().onSpeechStart?.(), ttsIdle: () => ttsHandlers?.onIdle(), level: (l: number) => last().onLevel?.(l) };
}

function composer(deps: VoiceDeps, sent: string[] = []) {
  return render(<Composer chatId="chat-v" blocked={null} running={false} onSend={async (t) => { sent.push(t); return null; }} onStop={() => {}} onOpenImage={() => {}} storage={store()} voiceDeps={deps} />);
}

describe("dictation (mode 1)", () => {
  test("record, see the clock, Done transcribes into the composer; nothing is sent", async () => {
    cleanup();
    const v = fakeVoice();
    const sent: string[] = [];
    composer(v.deps, sent);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "draft" } });
    fireEvent.click(screen.getByLabelText("Dictate"));
    await flush();
    expect(screen.getByTestId("dictation-bar").textContent).toContain("Recording");
    expect(screen.getByTestId("dictation-time").textContent).toBe("0:00");
    expect(screen.getByLabelText("Stop dictation").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByText("Done"));
    await flush();
    await flush();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("draft hello world");
    expect(screen.queryByTestId("dictation-bar")).toBeNull();
    expect(v.log).toEqual(["open", "record", "stop", "transcribe audio/mp4", "close"]);
    expect(sent).toEqual([]);
  });

  test("a recording is never stopped by a timer: three minutes later it is still recording until Done", async () => {
    cleanup();
    const real = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number) => { delays.push(ms ?? 0); return real(fn, ms); }) as unknown as typeof setTimeout;
    try {
      const v = fakeVoice();
      composer(v.deps);
      fireEvent.click(screen.getByLabelText("Dictate"));
      await flush();
      expect(delays.some((d) => d >= 60_000)).toBe(false);
      expect(screen.getByTestId("dictation-bar").textContent).toContain("Recording");
      fireEvent.click(screen.getByText("Cancel"));
      await flush();
    } finally {
      globalThis.setTimeout = real;
    }
  });

  test("text of finished pieces shows live while the recording goes on, in order", async () => {
    cleanup();
    const v = fakeVoice({ transcribe: async (b) => ({ ok: true, text: await b.text() }) });
    composer(v.deps);
    fireEvent.click(screen.getByLabelText("Dictate"));
    await flush();
    const seg = (t: string, overlapped = false) => ({ blob: new Blob([t]), mime: "audio/webm", seconds: 30, hadSpeech: true, overlapped });
    await act(async () => { v.recorders[0]?.onSegment?.(seg("first part of the talk")); });
    await flush();
    expect(screen.getByTestId("dictation-partial").textContent).toBe("first part of the talk");
    await act(async () => { v.recorders[0]?.onSegment?.(seg("second part")); });
    await flush();
    expect(screen.getByTestId("dictation-partial").textContent).toBe("first part of the talk second part");
    fireEvent.click(screen.getByText("Cancel"));
    await flush();
  });

  test("Cancel drops the recording without transcribing", async () => {
    cleanup();
    const v = fakeVoice();
    composer(v.deps);
    fireEvent.click(screen.getByLabelText("Dictate"));
    await flush();
    fireEvent.click(screen.getByText("Cancel"));
    await flush();
    expect(v.log).toEqual(["open", "record", "cancel", "close"]);
    expect(screen.queryByTestId("dictation-bar")).toBeNull();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
  });

  test("a denied microphone, an insecure page and a failed transcription are shown", async () => {
    cleanup();
    const denied = fakeVoice({ openMic: () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })) });
    composer(denied.deps);
    fireEvent.click(screen.getByLabelText("Dictate"));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Microphone permission was denied");
    cleanup();
    const http = fakeVoice({ origin: () => "Voice needs https or localhost: open this page over https (see the /trust page to set up the certificate) or use localhost." });
    composer(http.deps);
    fireEvent.click(screen.getByLabelText("Dictate"));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("https or localhost");
    cleanup();
    const broken = fakeVoice({ transcribe: async () => ({ ok: false, error: "Transcription failed: whisper/whisper-large-v3: FFmpeg conversion failed." }) });
    composer(broken.deps);
    fireEvent.click(screen.getByLabelText("Dictate"));
    await flush();
    fireEvent.click(screen.getByText("Done"));
    await flush();
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("FFmpeg conversion failed");
  });
});

describe("voice conversation (mode 2)", () => {
  function Harness({ deps, sent, first = "earlier reply", question = null }: { deps: VoiceDeps; sent: string[]; first?: string; question?: ConversationQuestion | null }) {
    const [messages, setMessages] = useState<Message[]>([msg("msg-01", { content: first })]);
    const voice = useVoiceConversation({ messages, question, send: async (text) => { sent.push(text); setMessages((m) => [...m, msg("msg-02", { role: "user", content: text }), msg("msg-03", { status: "streaming" })]); return null; } }, deps);
    return (
      <div>
        <span data-testid="phase">{voice.phase}</span>
        <span data-testid="err">{voice.error ?? ""}</span>
        <span data-testid="heard">{voice.heard}</span>
        <span data-testid="reply">{voice.reply.map((r) => r.text).join("|")}</span>
        <button type="button" onClick={voice.start}>go</button>
        <button type="button" onClick={voice.stop}>halt</button>
        <button type="button" onClick={voice.pause}>pause</button>
        <button type="button" onClick={voice.resume}>resume</button>
        <button type="button" onClick={voice.tap}>tap</button>
        <button type="button" onClick={() => { setMessages((m) => m.map((x) => (x.id === "msg-03" ? { ...x, status: "streaming", content: "First sentence is here. Second one comes" } : x))); }}>stream</button>
        <button type="button" onClick={() => { setMessages((m) => m.map((x) => (x.id === "msg-03" ? { ...x, status: "done", content: "First sentence is here. Second one comes now.\n```ts\nx\n```" } : x))); }}>finish</button>
      </div>
    );
  }
  const talk = async (v: ReturnType<typeof fakeVoice>) => { await act(async () => { v.speechEnd(); }); await flush(); await flush(); };

  test("listen → silence → send → speak sentence by sentence while it streams → listen again; End stops everything", async () => {
    cleanup();
    const v = fakeVoice();
    const sent: string[] = [];
    render(<Harness deps={v.deps} sent={sent} />);
    fireEvent.click(screen.getByText("go"));
    expect(v.log[0]).toBe("prime");
    await flush();
    expect(screen.getByTestId("phase").textContent).toBe("listening");
    expect(v.log).toContain("wake-lock");
    await talk(v);
    expect(sent).toEqual(["hello world"]);
    expect(screen.getByTestId("phase").textContent).toBe("thinking");
    fireEvent.click(screen.getByText("stream"));
    await flush();
    expect(v.log).toContain("say First sentence is here.");
    expect(v.log.some((l) => l.startsWith("say Second"))).toBe(false);
    expect(screen.getByTestId("phase").textContent).toBe("speaking");
    fireEvent.click(screen.getByText("finish"));
    await flush();
    expect(v.log).toContain("say Second one comes now.");
    expect(v.log).toContain("say code block");
    await act(async () => { v.ttsIdle(); });
    await flush();
    expect(screen.getByTestId("phase").textContent).toBe("listening");
    fireEvent.click(screen.getByText("halt"));
    await flush();
    expect(screen.getByTestId("phase").textContent).toBe("off");
    expect(v.log).toContain("tts-stop");
    expect(v.log.at(-1)).toBe("wake-release");
  });

  test("barge-in: speech while the assistant speaks stops the voice at once, keeps the recorder and skips the rest of the reply", async () => {
    cleanup();
    const v = fakeVoice();
    render(<Harness deps={v.deps} sent={[]} />);
    fireEvent.click(screen.getByText("go"));
    await flush();
    await talk(v);
    fireEvent.click(screen.getByText("stream"));
    await flush();
    expect(screen.getByTestId("phase").textContent).toBe("speaking");
    const recordsBefore = v.log.filter((l) => l === "record").length;
    await act(async () => { v.speechStart(); });
    await flush();
    expect(screen.getByTestId("phase").textContent).toBe("listening");
    expect(v.log).toContain("tts-stop");
    expect(v.log.filter((l) => l === "record").length).toBe(recordsBefore);
    fireEvent.click(screen.getByText("finish"));
    await flush();
    expect(v.log.some((l) => l.startsWith("say Second"))).toBe(false);
    fireEvent.click(screen.getByText("halt"));
    await flush();
  });

  test("tapping the orb while it speaks interrupts; pause silences, resume listens", async () => {
    cleanup();
    const v = fakeVoice();
    render(<Harness deps={v.deps} sent={[]} />);
    fireEvent.click(screen.getByText("go"));
    await flush();
    await talk(v);
    fireEvent.click(screen.getByText("stream"));
    await flush();
    fireEvent.click(screen.getByText("tap"));
    await flush();
    expect(screen.getByTestId("phase").textContent).toBe("listening");
    fireEvent.click(screen.getByText("pause"));
    await flush();
    expect(screen.getByTestId("phase").textContent).toBe("paused");
    fireEvent.click(screen.getByText("resume"));
    await flush();
    expect(screen.getByTestId("phase").textContent).toBe("listening");
    fireEvent.click(screen.getByText("halt"));
    await flush();
  });

  test("the clip goes out with the last reply's language as the hint (he after a Hebrew reply)", async () => {
    cleanup();
    const hints: (string | null | undefined)[] = [];
    const v = fakeVoice({ transcribe: async (_b, _m, language) => { hints.push(language); return { ok: true, text: "כן" }; } });
    render(<Harness deps={v.deps} sent={[]} first="שלום, מה שלומך היום?" />);
    fireEvent.click(screen.getByText("go"));
    await flush();
    await talk(v);
    expect(hints).toEqual(["he"]);
    fireEvent.click(screen.getByText("halt"));
    await flush();
  });

  test("a transcription failure ends the mode with the error", async () => {
    cleanup();
    const v = fakeVoice({ transcribe: async () => ({ ok: false, error: "Transcription failed: HTTP 502" }) });
    render(<Harness deps={v.deps} sent={[]} />);
    fireEvent.click(screen.getByText("go"));
    await flush();
    await talk(v);
    expect(screen.getByTestId("phase").textContent).toBe("off");
    expect(screen.getByTestId("err").textContent).toBe("Transcription failed: HTTP 502");
  });

  test("a denied microphone and an http page end the mode with a clear sentence and never open the mic", async () => {
    cleanup();
    const denied = fakeVoice({ openMic: () => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" })) });
    render(<Harness deps={denied.deps} sent={[]} />);
    fireEvent.click(screen.getByText("go"));
    await flush();
    expect(screen.getByTestId("err").textContent).toContain("permission was denied");
    cleanup();
    const http = fakeVoice({ origin: () => "Voice needs https or localhost: open this page over https (see the /trust page to set up the certificate) or use localhost." });
    render(<Harness deps={http.deps} sent={[]} />);
    fireEvent.click(screen.getByText("go"));
    await flush();
    expect(screen.getByTestId("err").textContent).toContain("/trust");
    expect(http.log).not.toContain("open");
  });

  test("a pending question is read with its options and a spoken answer picks the option", async () => {
    cleanup();
    const v = fakeVoice();
    const answers: Array<[string, string[][] | null]> = [];
    const part = { type: "question", id: "q1", state: "pending", asked_at: "", questions: [{ header: "H", question: "Ship it?", options: [{ label: "Yes ship", description: "" }, { label: "No wait", description: "" }], multiple: false, allowCustom: false }] } as unknown as ConversationQuestion["part"];
    render(<Harness deps={v.deps} sent={[]} question={{ part, answer: async (qid, a) => { answers.push([qid, a]); return null; } }} />);
    fireEvent.click(screen.getByText("go"));
    await flush();
    await talk(v);
    fireEvent.click(screen.getByText("finish"));
    await flush();
    expect(v.log).toContain("say Ship it? The options are: 1, Yes ship.");
    expect(v.log).toContain("say 2, No wait.");
    v.deps.transcribe = async () => ({ ok: true, text: "the second one" });
    await act(async () => { v.ttsIdle(); });
    await flush();
    expect(screen.getByTestId("phase").textContent).toBe("listening");
    await talk(v);
    expect(answers).toEqual([["q1", [["No wait"]]]]);
    fireEvent.click(screen.getByText("halt"));
    await flush();
  });
});

describe("transcribeClip", () => {
  test("adds the language hint to the request: the given one, else the browser's", async () => {
    const real = globalThis.fetch;
    const langs: (string | null)[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const lang = (init.body as FormData).get("language");
      langs.push(typeof lang === "string" ? lang : null);
      return Response.json({ text: "ok", model: "m" });
    }) as unknown as typeof fetch;
    try {
      expect(await transcribeClip(new Blob(["x"]), "audio/webm", "he")).toEqual({ ok: true, text: "ok" });
      await transcribeClip(new Blob(["x"]), "audio/webm", null);
      await transcribeClip(new Blob(["x"]), "audio/webm");
    } finally {
      globalThis.fetch = real;
    }
    const browser = (navigator.language || "").split("-")[0]?.toLowerCase() || null;
    expect(langs).toEqual(["he", null, browser === "iw" ? "he" : browser]);
  });
});
