import { afterAll, describe, expect, test } from "bun:test";
import { useState } from "react";
import { installDom } from "../test/dom";
import type { Message } from "../lib/chat-types";
import type { RecordOptions } from "./voice";
import type { VoiceDeps } from "./use-voice";

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
  let options: RecordOptions = {};
  const deps: VoiceDeps = {
    openMic: async () => { log.push("open"); return { getTracks: () => [] } as unknown as MediaStream; },
    closeMic: () => { log.push("close"); },
    record: (_s, o) => {
      options = o;
      log.push("record");
      return { mime: "audio/mp4", heardSpeech: true, stop: async () => { log.push("stop"); return new Blob(["x"], { type: "audio/mp4" }); }, cancel: () => { log.push("cancel"); } };
    },
    transcribe: async (_b, mime) => { log.push(`transcribe ${mime}`); return { ok: true, text: "hello world" }; },
    speak: async (text) => { log.push(`speak ${text}`); },
    stopSpeaking: () => { log.push("stopSpeaking"); },
    primeSpeech: () => { log.push("prime"); },
    ...over,
  };
  return { deps, log, speechEnd: () => options.onSpeechEnd?.(), level: (l: number) => options.onLevel?.(l) };
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
    expect(v.log).toEqual(["open", "record", "stop", "close", "transcribe audio/mp4"]);
    expect(sent).toEqual([]);
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

  test("a denied microphone and a failed transcription are shown", async () => {
    cleanup();
    const denied = fakeVoice({ openMic: () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })) });
    composer(denied.deps);
    fireEvent.click(screen.getByLabelText("Dictate"));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Microphone permission was denied");
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
  function Harness({ deps, sent, first = "earlier reply" }: { deps: VoiceDeps; sent: string[]; first?: string }) {
    const [messages, setMessages] = useState<Message[]>([msg("msg-01", { content: first })]);
    const voice = useVoiceConversation({ messages, send: async (text) => { sent.push(text); setMessages((m) => [...m, msg("msg-02", { role: "user", content: text }), msg("msg-03", { status: "streaming" })]); return null; } }, deps);
    return (
      <div>
        <span data-testid="phase">{voice.phase}</span>
        <span data-testid="err">{voice.error ?? ""}</span>
        <button type="button" onClick={voice.start}>go</button>
        <button type="button" onClick={voice.stop}>halt</button>
        <button type="button" onClick={() => { setMessages((m) => m.map((x) => (x.id === "msg-03" ? { ...x, status: "done", content: "the **answer**" } : x))); }}>finish</button>
      </div>
    );
  }

  test("listen → silence → transcribe → send → wait for the reply → read it → listen again; Stop ends it", async () => {
    cleanup();
    const v = fakeVoice();
    const sent: string[] = [];
    render(<Harness deps={v.deps} sent={sent} />);
    fireEvent.click(screen.getByText("go"));
    expect(v.log[0]).toBe("prime");
    await flush();
    expect(screen.getByTestId("phase").textContent).toBe("listening");
    await act(async () => { v.speechEnd(); });
    await flush();
    await flush();
    expect(sent).toEqual(["hello world"]);
    expect(screen.getByTestId("phase").textContent).toBe("waiting");
    expect(v.log.some((l) => l.startsWith("speak"))).toBe(false);
    fireEvent.click(screen.getByText("finish"));
    await flush();
    await flush();
    expect(v.log).toContain("speak the **answer**");
    expect(screen.getByTestId("phase").textContent).toBe("listening");
    expect(v.log.filter((l) => l === "record").length).toBe(2);
    fireEvent.click(screen.getByText("halt"));
    await flush();
    expect(screen.getByTestId("phase").textContent).toBe("off");
    expect(v.log.slice(-3)).toEqual(["cancel", "close", "stopSpeaking"]);
  });

  test("the clip goes out with the last reply's language as the hint (he after a Hebrew reply)", async () => {
    cleanup();
    const hints: (string | null | undefined)[] = [];
    const v = fakeVoice({ transcribe: async (_b, _m, language) => { hints.push(language); return { ok: true, text: "כן" }; } });
    render(<Harness deps={v.deps} sent={[]} first="שלום, מה שלומך היום?" />);
    fireEvent.click(screen.getByText("go"));
    await flush();
    await act(async () => { v.speechEnd(); });
    await flush();
    await flush();
    expect(hints).toEqual(["he"]);
    fireEvent.click(screen.getByText("halt"));
    await flush();
  });

  test("a transcription failure stops the loop with the error", async () => {
    cleanup();
    const v = fakeVoice({ transcribe: async () => ({ ok: false, error: "Transcription failed: HTTP 502" }) });
    render(<Harness deps={v.deps} sent={[]} />);
    fireEvent.click(screen.getByText("go"));
    await flush();
    await act(async () => { v.speechEnd(); });
    await flush();
    await flush();
    expect(screen.getByTestId("phase").textContent).toBe("off");
    expect(screen.getByTestId("err").textContent).toBe("Transcription failed: HTTP 502");
  });

  test("the composer shows the conversation bar and its Stop button", async () => {
    cleanup();
    const v = fakeVoice();
    let stopped = 0;
    render(<Composer chatId="chat-v" blocked={null} running={false} onSend={async () => null} onStop={() => {}} onOpenImage={() => {}} storage={store()} voiceDeps={v.deps}
      voice={{ phase: "listening", level: 0.4, error: null, start: () => {}, stop: () => { stopped += 1; }, clearError: () => {} }} />);
    expect(screen.getByTestId("conversation-phase").textContent).toBe("Listening…");
    expect(screen.getByLabelText("Stop voice conversation").getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("Dictate") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Stop voice"));
    expect(stopped).toBe(1);
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
