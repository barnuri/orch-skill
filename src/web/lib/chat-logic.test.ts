import { describe, expect, test } from "bun:test";
import { applyChatEvent, filesFromClipboard, formatBytes, loadDraft, pastedName, prependOlder, resolvePickers, resumeId, retryTarget, saveDraft, sortMessages, upsertMessage, validateFile, MAX_FILE_BYTES, MAX_MESSAGE_BYTES } from "./chat-logic";
import type { ChatOptions, Message } from "./chat-types";
import { formatDuration } from "./duration";
import { fmtDur } from "./format";

const msg = (id: string, over: Partial<Message> = {}): Message => ({
  id, chat_id: "chat-1", role: "assistant", content: "", status: "done", error: null, model_used: null,
  input_tokens: 0, output_tokens: 0, cost_usd: null, started_at: null, finished_at: null, created_at: "", attachments: [], ...over,
});

const model = (id: string, d = false) => ({ id, label: id.toUpperCase(), slug: id, description: `${id} model`, default: d });
const profile = (name: string, models: string[], over: Record<string, unknown> = {}) => ({ name, description: "", enabled: true, configured: true, problem: null, models: models.map((m, i) => model(m, i === 0)), ...over });
const harness = (id: string, profiles: ReturnType<typeof profile>[], over: Record<string, unknown> = {}) => ({ id, label: id, enabled: true, available: true, persistent: true, profiles, ...over });
const opts = (harnesses: ReturnType<typeof harness>[], dh: string | null = null, dp: string | null = null): ChatOptions => ({ harnesses, default_harness: dh, default_profile: dp }) as ChatOptions;

describe("formatDuration", () => {
  test("seconds, minutes, hours, days", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(139_000)).toBe("2m 19s");
    expect(formatDuration(3_780_000)).toBe("1h 3m");
    expect(formatDuration((2 * 24 + 4) * 3_600_000)).toBe("2d 4h");
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
    expect(formatDuration(59_400)).toBe("59s");
    expect(formatDuration(59_600)).toBe("1m 0s");
  });
  test("fmtDur uses it, so long runs read in days", () => {
    expect(fmtDur("2026-01-01T00:00:00Z", "2026-01-03T04:00:00Z")).toBe("2d 4h");
  });
});

describe("message ordering and events", () => {
  test("sorts by id so tool rows land after their assistant row", () => {
    expect(sortMessages([msg("msg-c"), msg("msg-a"), msg("msg-b")]).map((m) => m.id)).toEqual(["msg-a", "msg-b", "msg-c"]);
  });
  test("upsert replaces by id and keeps grown streaming text", () => {
    const list = [msg("msg-a", { status: "streaming", content: "hello world" })];
    expect(upsertMessage(list, msg("msg-a", { status: "streaming", content: "hello" }))[0]?.content).toBe("hello world");
    expect(upsertMessage(list, msg("msg-a", { status: "done", content: "hello world!" }))[0]?.content).toBe("hello world!");
    expect(upsertMessage(list, msg("msg-0")).map((m) => m.id)).toEqual(["msg-0", "msg-a"]);
  });
  test("deltas append by end offset, ignore replays and gaps", () => {
    let list = [msg("msg-a", { status: "streaming", content: "ab" })];
    list = applyChatEvent(list, { event: "delta", data: { message_id: "msg-a", text: "cd", offset: 4 } }, "t");
    expect(list[0]?.content).toBe("abcd");
    list = applyChatEvent(list, { event: "delta", data: { message_id: "msg-a", text: "cd", offset: 4 } }, "t");
    expect(list[0]?.content).toBe("abcd");
    list = applyChatEvent(list, { event: "delta", data: { message_id: "msg-a", text: "x", offset: 9 } }, "t");
    expect(list[0]?.content).toBe("abcd");
    list = applyChatEvent(list, { event: "delta", data: { message_id: "msg-a", text: "bcdef", offset: 6 } }, "t");
    expect(list[0]?.content).toBe("abcdef");
  });
  test("usage and done update the footer fields", () => {
    let list = [msg("msg-a", { status: "streaming", started_at: "2026-01-01T00:00:00Z" })];
    list = applyChatEvent(list, { event: "usage", data: { message_id: "msg-a", input_tokens: 11, output_tokens: 7, cost_usd: 0.01, model: "fake-model" } }, "t");
    list = applyChatEvent(list, { event: "done", data: { message_id: "msg-a", status: "error", error: "boom" } }, "2026-01-01T00:00:05Z");
    expect(list[0]).toMatchObject({ input_tokens: 11, output_tokens: 7, cost_usd: 0.01, model_used: "fake-model", status: "error", error: "boom", finished_at: "2026-01-01T00:00:05Z" });
  });
  test("message events add rows and malformed events do nothing", () => {
    const list = applyChatEvent([], { event: "message", data: { message: msg("msg-a") } }, "t");
    expect(list).toHaveLength(1);
    expect(applyChatEvent(list, { event: "message", data: null }, "t")).toHaveLength(1);
    expect(applyChatEvent(list, { event: "delta", data: { message_id: "nope", text: "x", offset: 1 } }, "t")).toHaveLength(1);
  });
  test("older pages merge under the list without duplicates", () => {
    const merged = prependOlder([msg("msg-c"), msg("msg-d")], [msg("msg-c"), msg("msg-b"), msg("msg-a")]);
    expect(merged.map((m) => m.id)).toEqual(["msg-a", "msg-b", "msg-c", "msg-d"]);
  });
  test("resume id prefers the oldest open reply over a later tool row", () => {
    const list = [msg("msg-1", { role: "user", content: "hi" }), msg("msg-2", { status: "streaming", content: "abc" }), msg("msg-3", { role: "tool", content: "Read" })];
    expect(resumeId(list)).toBe("msg-2.3");
    expect(resumeId([msg("msg-1", { content: "xy" })])).toBe("msg-1.2");
    expect(resumeId([])).toBeNull();
  });
  test("retry targets a failed last reply and its user text", () => {
    const list = [msg("msg-1", { role: "user", content: "do it" }), msg("msg-2", { status: "error" })];
    expect(retryTarget(list)?.text).toBe("do it");
    expect(retryTarget([...list, msg("msg-3", { role: "user", content: "next" })])).toBeNull();
    expect(retryTarget([msg("msg-1", { role: "user" }), msg("msg-2")])).toBeNull();
  });
});

describe("picker cascade", () => {
  const claude = harness("claude", [profile("fast", ["haiku", "sonnet"]), profile("deep", ["opus"])]);
  const codex = harness("codex", [profile("codex-a", ["gpt"])], { persistent: false });
  test("defaults to the default profile and its default model", () => {
    const p = resolvePickers(opts([claude, codex], "claude", "deep"), null);
    expect(p.selection).toEqual({ harness: "claude", profile: "deep", model: "opus" });
    expect(p.canStart).toBe(true);
    expect(p.persistent).toBe(true);
  });
  test("changing the harness resets profile and model", () => {
    const p = resolvePickers(opts([claude, codex]), { harness: "codex", profile: "fast", model: "haiku" });
    expect(p.selection).toEqual({ harness: "codex", profile: "codex-a", model: "gpt" });
    expect(p.persistent).toBe(false);
  });
  test("a select with one choice is locked, with several it is free", () => {
    const p = resolvePickers(opts([claude]), null);
    expect(p.harness.locked).toBe(true);
    expect(p.profile.locked).toBe(false);
    expect(resolvePickers(opts([claude]), { harness: "claude", profile: "deep", model: null }).model.locked).toBe(true);
    expect(p.model.locked).toBe(false);
  });
  test("disabled harnesses and unconfigured profiles do not count as choices", () => {
    const off = harness("gemini", [profile("g", ["flash"])], { enabled: false });
    const p = resolvePickers(opts([claude, off]), null);
    expect(p.harness.locked).toBe(true);
    expect(p.harness.options).toHaveLength(2);
    const half = harness("claude", [profile("a", ["x"]), profile("b", ["y"], { configured: false, problem: "ANTHROPIC_KEY is not set" })]);
    const q = resolvePickers(opts([half]), { harness: "claude", profile: "b", model: null });
    expect(q.selection.profile).toBe("a");
    expect(q.profile.locked).toBe(true);
  });
  test("nothing usable: pickers disabled with the reason, cannot start", () => {
    const p = resolvePickers(opts([harness("claude", [profile("a", ["x"], { configured: false, problem: "ANTHROPIC_KEY is not set" })], { available: false })]), null);
    expect(p.canStart).toBe(false);
    expect(p.problem).toBe("no harness is enabled and installed: enable one on the Harnesses page");
    const q = resolvePickers(opts([harness("claude", [profile("a", ["x"], { configured: false, problem: "ANTHROPIC_KEY is not set" })])]), null);
    expect(q.problem).toBe("ANTHROPIC_KEY is not set");
    expect(q.canStart).toBe(false);
    expect(resolvePickers(opts([]), null).canStart).toBe(false);
  });
});

describe("attachments", () => {
  test("validateFile enforces the backend limits", () => {
    expect(validateFile({ name: "a.png", size: 10, type: "image/png" }, 0, 0)).toBeNull();
    expect(validateFile({ name: "a", size: 0, type: "" }, 0, 0)).toContain("empty");
    expect(validateFile({ name: "big.bin", size: MAX_FILE_BYTES + 1, type: "" }, 0, 0)).toContain("25 MB");
    expect(validateFile({ name: "b", size: 1000, type: "" }, MAX_MESSAGE_BYTES - 500, 3)).toContain("100 MB");
    expect(validateFile({ name: "c", size: 1, type: "" }, 0, 20)).toContain("at most 20");
  });
  test("formatBytes", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
  test("pasted images get a time-stamped name, real names stay", () => {
    expect(pastedName(new File(["x"], "image.png", { type: "image/png" }), 123).name).toBe("pasted-123.png");
    expect(pastedName(new File(["x"], "", { type: "image/jpeg" }), 5).name).toBe("pasted-5.jpg");
    expect(pastedName(new File(["x"], "report.png", { type: "image/png" }), 123).name).toBe("report.png");
    expect(pastedName(new File(["x"], "notes.txt", { type: "text/plain" }), 123).name).toBe("notes.txt");
  });
  test("clipboard files come from files, then items; plain text gives none", () => {
    const png = new File(["x"], "image.png", { type: "image/png" });
    expect(filesFromClipboard({ files: [png] }, 9).map((f) => f.name)).toEqual(["pasted-9.png"]);
    expect(filesFromClipboard({ files: [], items: [{ kind: "file", getAsFile: () => png }, { kind: "string", getAsFile: () => null }] }, 9)).toHaveLength(1);
    expect(filesFromClipboard({ files: [], items: [{ kind: "string", getAsFile: () => null }] }, 9)).toHaveLength(0);
    expect(filesFromClipboard(null, 9)).toHaveLength(0);
  });
});

describe("draft persistence", () => {
  const mem = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data };
  };
  test("round trips per chat and clears when empty", () => {
    const s = mem();
    saveDraft(s, "chat-1", { text: "hi", attachments: [] });
    saveDraft(s, "chat-2", { text: "other", attachments: [] });
    expect(loadDraft(s, "chat-1").text).toBe("hi");
    saveDraft(s, "chat-1", { text: "", attachments: [] });
    expect(s.data.has("orch.chat.draft.chat-1")).toBe(false);
    expect(loadDraft(s, "chat-2").text).toBe("other");
  });
  test("a corrupt draft loads as empty", () => {
    const s = mem();
    s.setItem("orch.chat.draft.chat-1", "{nope");
    expect(loadDraft(s, "chat-1")).toEqual({ text: "", attachments: [] });
  });
});
