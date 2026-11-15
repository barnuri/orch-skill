import { afterAll, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";
import type { ChatOptions, Message } from "../lib/chat-types";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, waitFor, act } = await import("@testing-library/react");
const { Pickers } = await import("./Pickers");
const { Composer } = await import("./Composer");
const { normalizeSelection } = await import("../lib/chat-logic");
const { MessageView } = await import("./MessageView");
const { parseRoute, routeKey } = await import("../router/route");

afterAll(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 100));
  uninstall();
});

const model = (id: string, d = false) => ({ id, label: id.toUpperCase(), slug: id, description: `${id} model`, default: d });
const profile = (name: string, models: string[], over: Record<string, unknown> = {}) => ({ name, description: "", enabled: true, configured: true, problem: null, models: models.map((m, i) => model(m, i === 0)), ...over });
const harness = (id: string, profiles: unknown[], over: Record<string, unknown> = {}) => ({ id, label: id, enabled: true, available: true, persistent: true, profiles, ...over });
const options = (harnesses: unknown[]): ChatOptions => ({ harnesses, default_harness: null, default_profile: null }) as ChatOptions;

const btn = (id: string) => screen.getByTestId(id).querySelector("button") as HTMLButtonElement;

describe("Pickers", () => {
  test("one choice at each level renders all three disabled with their single value", () => {
    cleanup();
    render(<Pickers options={options([harness("claude", [profile("fast", ["haiku"])])])} selection={{ harness: "claude", profile: "fast", model: "haiku" }} onChange={() => {}} locked={false} modelUsed={null} />);
    for (const id of ["picker-harness", "picker-profile", "picker-model"]) {
      expect(btn(id).disabled).toBe(true);
    }
    expect(btn("picker-model").textContent).toBe("HAIKU");
    expect(screen.getByTestId("picker-model").textContent).toContain("only model available");
    expect(screen.getByTestId("pickers").textContent).toContain("one process, one turn");
  });
  test("several choices stay enabled and picking a profile resets the model", () => {
    cleanup();
    const seen: unknown[] = [];
    render(<Pickers options={options([harness("claude", [profile("fast", ["haiku", "sonnet"]), profile("deep", ["opus", "o2"])], { persistent: false }), harness("codex", [profile("c", ["gpt"])])])} selection={{ harness: "claude", profile: "fast", model: "sonnet" }} onChange={(s) => seen.push(s)} locked={false} modelUsed="claude-sonnet-x" />);
    expect(btn("picker-harness").disabled).toBe(false);
    expect(btn("picker-model").disabled).toBe(false);
    expect(screen.getByTestId("pickers").textContent).toContain("replays recent history");
    expect(screen.getByTestId("pickers").textContent).toContain("claude-sonnet-x");
    fireEvent.click(btn("picker-profile"));
    fireEvent.click(screen.getByRole("option", { name: /deep/ }));
    expect(seen).toEqual([{ harness: "claude", profile: "deep", model: "opus" }]);
  });
  test("a disabled harness is listed but cannot be picked, with its reason", () => {
    cleanup();
    const seen: unknown[] = [];
    render(<Pickers options={options([harness("claude", [profile("a", ["x"]), profile("b", ["y"])]), harness("gemini", [profile("g", ["z"])], { enabled: false })])} selection={{ harness: "claude", profile: "a", model: "x" }} onChange={(s) => seen.push(s)} locked={false} modelUsed={null} />);
    expect(btn("picker-harness").disabled).toBe(true);
    const option = screen.getAllByRole("option", { hidden: true }).find((o) => o.textContent?.includes("gemini")) as HTMLElement;
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.textContent).toContain("disabled in settings");
    fireEvent.click(option);
    expect(seen).toEqual([]);
  });
  test("a chat on a disabled harness keeps it shown, greyed, and the picker stays open to switch to the enabled one", () => {
    cleanup();
    const seen: unknown[] = [];
    render(<Pickers options={options([harness("claude", [profile("a", ["x"])], { enabled: false }), harness("opencode", [profile("oc", ["m1", "m2"])])])} selection={{ harness: "claude", profile: "a", model: "x" }} onChange={(s) => seen.push(s)} locked={false} modelUsed={null} />);
    expect(btn("picker-harness").disabled).toBe(false);
    expect(btn("picker-harness").textContent).toBe("claude");
    expect(screen.getByTestId("picker-problem").textContent).toContain("pick opencode above to send");
    const grey = screen.getAllByRole("option", { hidden: true }).find((o) => o.textContent?.includes("claude")) as HTMLElement;
    expect(grey.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(btn("picker-harness"));
    fireEvent.click(screen.getByRole("option", { name: /opencode/ }));
    expect(seen).toEqual([{ harness: "opencode", profile: "oc", model: "m1" }]);
  });
  test("a new chat defaults to the first enabled harness, and to the first one when none is usable", () => {
    const on = options([harness("claude", [profile("a", ["x"])], { enabled: false }), harness("opencode", [profile("oc", ["m"])])]);
    expect(normalizeSelection(on, null)).toEqual({ harness: "opencode", profile: "oc", model: "m" });
    const none = options([harness("claude", [profile("a", ["x"])], { enabled: false })]);
    expect(normalizeSelection(none, null).harness).toBe("claude");
  });
  test("an unconfigured profile shows the problem; locked chats are read-only", () => {
    cleanup();
    render(<Pickers options={options([harness("claude", [profile("a", ["x"], { configured: false, problem: "KEY is not set" })])])} selection={{ harness: "claude", profile: "a", model: "x" }} onChange={() => {}} locked={false} modelUsed={null} />);
    expect(screen.getByTestId("pickers").textContent).toContain("KEY is not set");
    cleanup();
    render(<Pickers options={options([harness("claude", [profile("a", ["x", "y"]), profile("b", ["z"])])])} selection={{ harness: "claude", profile: "b", model: "z" }} onChange={() => {}} locked modelUsed={null} />);
    expect(btn("picker-profile").disabled).toBe(true);
    expect(btn("picker-profile").textContent).toBe("b");
    expect(screen.getByTestId("picker-model").textContent).toContain("locked while a reply is running");
  });
});

const store = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data } as unknown as Storage & { data: Map<string, string> };
};
const att = (id: string, name: string) => ({ id, chat_id: "chat-1", message_id: null, filename: name, mime: "text/plain", size: 5, sha256: "", created_at: "" });

describe("Composer", () => {
  test("paste of an image uploads it under a pasted-<time> name, and send waits for the upload", async () => {
    cleanup();
    const names: string[] = [];
    let finish: (() => void) | null = null;
    const upload = (_c: string, file: File) => {
      names.push(file.name);
      return { abort: () => {}, promise: new Promise<{ ok: true; attachment: ReturnType<typeof att> }>((r) => { finish = () => r({ ok: true, attachment: att("att-1", file.name) }); }) };
    };
    const sent: unknown[] = [];
    render(<Composer chatId="chat-1" blocked={null} running={false} onSend={async (t, ids) => { sent.push([t, ids]); return null; }} onStop={() => {}} onOpenImage={() => {}} storage={store()} upload={upload as never} />);
    const area = screen.getByLabelText("Message");
    fireEvent.change(area, { target: { value: "look" } });
    fireEvent.paste(area, { clipboardData: { files: [new File(["x"], "image.png", { type: "image/png" })], items: [] } });
    expect(names[0]).toMatch(/^pasted-\d+\.png$/);
    expect((screen.getByRole("button", { name: /Uploading/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { (finish as unknown as () => void)(); });
    const send = await screen.findByRole("button", { name: "Send" });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.click(send); });
    expect(sent).toEqual([["look", ["att-1"]]]);
    await waitFor(() => expect((area as HTMLTextAreaElement).value).toBe(""));
  });
  test("plain-text paste is left alone; oversize files show a per-file error and no upload", () => {
    cleanup();
    let uploads = 0;
    render(<Composer chatId="chat-1" blocked={null} running={false} onSend={async () => null} onStop={() => {}} onOpenImage={() => {}} storage={store()} upload={(() => { uploads += 1; return { abort: () => {}, promise: new Promise(() => {}) }; }) as never} />);
    const area = screen.getByLabelText("Message");
    expect(fireEvent.paste(area, { clipboardData: { files: [], items: [] } })).toBe(true);
    const big = new File(["x"], "big.bin");
    Object.defineProperty(big, "size", { value: 26 * 1024 * 1024 });
    fireEvent.drop(screen.getByTestId("file-input").closest(".composer") as HTMLElement, { dataTransfer: { files: [big], types: ["Files"] } });
    expect(uploads).toBe(0);
    expect(screen.getByRole("alert").textContent).toContain("25 MB per file");
  });
  test("text and uploaded attachments survive a remount", async () => {
    cleanup();
    const s = store();
    const props = { chatId: "chat-1", blocked: null, running: false, onSend: async () => null, onStop: () => {}, onOpenImage: () => {}, storage: s, upload: ((_c: string, f: File) => ({ abort: () => {}, promise: Promise.resolve({ ok: true as const, attachment: att("att-9", f.name) }) })) as never };
    const first = render(<Composer {...props} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "unsent words" } });
    fireEvent.drop(first.container.querySelector(".composer") as HTMLElement, { dataTransfer: { files: [new File(["abc"], "notes.txt", { type: "text/plain" })], types: ["Files"] } });
    await screen.findByText("notes.txt");
    first.unmount();
    render(<Composer {...props} />);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("unsent words");
    expect(screen.getByText("notes.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    expect(screen.queryByText("notes.txt")).toBeNull();
  });
  test("the toolbar slot renders above the input and the box stays usable (only an archived chat blocks it)", () => {
    cleanup();
    render(<Composer chatId="c" blocked={null} running={false} toolbar={<span data-testid="tb">pickers</span>} onSend={async () => null} onStop={() => {}} onOpenImage={() => {}} storage={store()} />);
    expect(screen.getByTestId("composer-toolbar").textContent).toBe("pickers");
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(false);
  });
  test("running shows Stop; blocked disables the box with the reason", () => {
    cleanup();
    let stopped = 0;
    render(<Composer chatId="c" blocked={null} running onSend={async () => null} onStop={() => { stopped += 1; }} onOpenImage={() => {}} storage={store()} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stopped).toBe(1);
    cleanup();
    render(<Composer chatId="c" blocked="no usable harness" running={false} onSend={async () => null} onStop={() => {}} onOpenImage={() => {}} storage={store()} />);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);
  });
});

const row = (over: Partial<Message>): Message => ({ id: "msg-1", chat_id: "c", role: "assistant", content: "", status: "done", error: null, model_used: null, input_tokens: 0, output_tokens: 0, cost_usd: null, started_at: null, finished_at: null, created_at: "", attachments: [], ...over });

describe("MessageView", () => {
  test("a live message ticks, a finished one is static, and the footer shows model, tokens and cost", () => {
    cleanup();
    const started = "2026-01-01T00:00:00Z";
    const t0 = Date.parse(started);
    const { rerender } = render(<MessageView message={row({ status: "streaming", started_at: started })} now={t0 + 45_000} onOpenImage={() => {}} />);
    expect(screen.getByTestId("msg-duration").textContent).toBe("45s");
    rerender(<MessageView message={row({ status: "streaming", started_at: started })} now={t0 + 139_000} onOpenImage={() => {}} />);
    expect(screen.getByTestId("msg-duration").textContent).toBe("2m 19s");
    rerender(<MessageView message={row({ status: "done", started_at: started, finished_at: "2026-01-01T00:00:10Z", model_used: "fake-model", input_tokens: 11, output_tokens: 7, cost_usd: 0.0123 })} now={t0 + 999_000} onOpenImage={() => {}} />);
    const foot = screen.getByTestId("msg-foot").textContent ?? "";
    expect(foot).toContain("10s");
    expect(foot).toContain("fake-model");
    expect(foot).toContain("11 in / 7 out");
    expect(foot).toContain("$0.01");
  });
  test("an error shows inline with Retry only when a handler is given; tool rows expand", () => {
    cleanup();
    let retried = 0;
    render(<MessageView message={row({ status: "error", error: "model exploded" })} now={0} onOpenImage={() => {}} onRetry={() => { retried += 1; }} />);
    expect(screen.getByRole("alert").textContent).toContain("model exploded");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retried).toBe(1);
    cleanup();
    render(<MessageView message={row({ role: "tool", content: "Read: /tmp/x" })} now={0} onOpenImage={() => {}} />);
    const toggle = screen.getByRole("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("routes", () => {
  test("chat and project hashes", () => {
    expect(parseRoute("#/chats")).toEqual({ kind: "chats", chatId: null });
    expect(parseRoute("#/chats/chat-1")).toEqual({ kind: "chats", chatId: "chat-1" });
    expect(parseRoute("#/projects/prj-1")).toEqual({ kind: "project", projectId: "prj-1" });
    expect(parseRoute("#/chats/%E0%A4%A")).toEqual({ kind: "chats", chatId: null });
    expect(routeKey(parseRoute("#/chats/chat-1"))).toBe("chats:chat-1");
  });
});
