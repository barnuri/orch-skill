import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../test/dom";
import type { ArtifactInfo, ArtifactKind, ArtifactVersion } from "../../../shared/artifacts";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, waitFor, act } = await import("@testing-library/react");
mock.module("mermaid", () => ({ default: { initialize: () => undefined, render: async (_id: string, src: string) => ({ svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${src.length}</text></svg>` }) } }));
(URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => "blob:test";
(URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
const { useArtifacts } = await import("./use-artifacts");
const { ArtifactBar, ArtifactLayout } = await import("./ArtifactLayout");
const { parseCsv } = await import("./Table");
const { selectionInfo } = await import("./selection");
const { refBlock, mentionedNames } = await import("../../../shared/artifacts");

const realFetch = globalThis.fetch;
afterAll(async () => {
  cleanup();
  globalThis.fetch = realFetch;
  await new Promise((r) => setTimeout(r, 50));
  uninstall();
});

interface Fake {
  files: Map<string, { kind: ArtifactKind; versions: Array<{ text: string; author?: ArtifactVersion["author"] }> }>;
  push: (data: Record<string, unknown>) => void;
  calls: string[];
}

const hashOf = (text: string): string => `h${text.length}${text.charCodeAt(0)}`;

function installFake(): Fake {
  const enc = new TextEncoder();
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const fake: Fake = {
    files: new Map(),
    calls: [],
    push: (data) => ctrl?.enqueue(enc.encode(`event: artifact\ndata: ${JSON.stringify(data)}\n\n`)),
  };
  const info = (): ArtifactInfo[] =>
    [...fake.files].map(([name, f]) => ({ name, kind: f.kind, size: 1, modified: "2026-01-01T00:00:00Z", version: f.versions.length, hash: hashOf(f.versions.at(-1)!.text) }));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fake.calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/events")) {
      return new Response(new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } }), { headers: { "Content-Type": "text/event-stream" } });
    }
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { headers: { "Content-Type": "application/json" } });
    if (/\/artifacts$/.test(url)) {
      return json({ items: info(), dir: "/work/.orch/chats/c1/artifacts" });
    }
    const m = /\/artifacts\/([^/?]+)\/(versions|content|view|restore)(\?.*)?$/.exec(url);
    const f = m === null ? undefined : fake.files.get(decodeURIComponent(m[1]!));
    if (m === null || f === undefined) {
      return new Response("{}", { status: 404 });
    }
    if (m[2] === "versions") {
      return json({ items: f.versions.map((v, i): ArtifactVersion => ({ n: i + 1, at: "2026-01-01T00:00:00Z", turn: "msg-1", author: v.author ?? "agent", hash: hashOf(v.text), size: v.text.length })) });
    }
    if (m[2] === "view") {
      return json({ url: "/artifact-view/cap123" });
    }
    if (m[2] === "restore") {
      f.versions.push({ text: f.versions[JSON.parse(String(init?.body)).version - 1]!.text, author: "restore" });
      return json({});
    }
    const ver = /version=(\d+)/.exec(m[3] ?? "");
    const v = ver === null ? f.versions.at(-1)! : f.versions[Number(ver[1]) - 1]!;
    return new Response(v.text);
  }) as typeof fetch;
  return fake;
}

let last: ReturnType<typeof useArtifacts> | null = null;
function Harness() {
  const state = useArtifacts("c1");
  last = state;
  return (
    <ArtifactLayout state={state}>
      <div data-testid="thread">thread</div>
      <ArtifactBar state={state} />
      <textarea className="composer-text" />
    </ArtifactLayout>
  );
}

let fake: Fake;
beforeEach(() => {
  cleanup();
  localStorage.clear();
  fake = installFake();
});
afterEach(() => cleanup());

const created = (name: string, kind: ArtifactKind, version = 1, turn = "msg-1", text = ""): Record<string, unknown> => ({ chat_id: "c1", name, change: "created", version, kind, hash: hashOf(text), turn });
async function boot(files: Array<[string, ArtifactKind, string[]]>): Promise<void> {
  for (const [name, kind, texts] of files) {
    fake.files.set(name, { kind, versions: texts.map((text) => ({ text })) });
  }
  render(<Harness />);
  await waitFor(() => expect(last?.items.length).toBe(files.length));
}
async function open(name: string): Promise<void> {
  await act(async () => { last?.setOpen(true); last?.select(name); });
  await waitFor(() => expect(screen.getByTestId("art-panel")).toBeTruthy());
}

describe("panel opens and follows the agent", () => {
  test("it opens by itself on the first artifact of a turn, once per turn, and the user can turn that off", async () => {
    await boot([]);
    expect(screen.queryByTestId("art-panel")).toBeNull();
    expect(screen.queryByTestId("art-bar")).toBeNull();
    fake.files.set("a.md", { kind: "markdown", versions: [{ text: "# hi" }] });
    await act(async () => { fake.push(created("a.md", "markdown", 1, "msg-1", "# hi")); await new Promise((r) => setTimeout(r, 20)); });
    await waitFor(() => expect(screen.getByTestId("art-panel")).toBeTruthy());
    expect(screen.getByTestId("art-badge").textContent).toBe("Markdown");
    expect(screen.getByTestId("thread")).toBeTruthy();
    fireEvent.click(screen.getByTestId("art-close"));
    expect(screen.queryByTestId("art-panel")).toBeNull();
    fake.files.set("b.md", { kind: "markdown", versions: [{ text: "# b" }] });
    await act(async () => { fake.push(created("b.md", "markdown", 1, "msg-1", "# b")); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByTestId("art-panel")).toBeNull();
    await act(async () => { fake.push(created("c.md", "markdown", 1, "msg-2")); await new Promise((r) => setTimeout(r, 20)); });
    await waitFor(() => expect(screen.getByTestId("art-panel")).toBeTruthy());
  });

  test("auto-open off keeps the panel closed; the toggle opens it", async () => {
    localStorage.setItem("orch.artifacts.autoopen", "0");
    await boot([["a.md", "markdown", ["# hi"]]]);
    await act(async () => { fake.push(created("a.md", "markdown")); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByTestId("art-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("art-toggle"));
    expect(screen.getByTestId("art-panel")).toBeTruthy();
  });

  test("a live update reloads the content, marks the changed lines, and keeps the scroll container", async () => {
    await boot([["a.ts", "code", ["const a = 1;\nconst b = 2;"]]]);
    await open("a.ts");
    await waitFor(() => expect(screen.getByTestId("art-code").textContent).toContain("const b = 2;"));
    const scroller = screen.getByTestId("art-body");
    fake.files.get("a.ts")!.versions.push({ text: "const a = 1;\nconst b = 3;\nconst c = 4;" });
    await act(async () => { fake.push({ ...created("a.ts", "code", 2), change: "updated", hash: hashOf("const a = 1;\nconst b = 3;\nconst c = 4;") }); await new Promise((r) => setTimeout(r, 50)); });
    await waitFor(() => expect(screen.getByTestId("art-code").textContent).toContain("const c = 4;"));
    expect(screen.getByTestId("art-body")).toBe(scroller);
    await waitFor(() => expect(document.querySelectorAll(".art-line.is-changed").length).toBe(2));
    expect([...document.querySelectorAll(".art-line.is-changed")].map((e) => e.getAttribute("data-line"))).toEqual(["2", "3"]);
  });
});

describe("versions", () => {
  test("an HTML artifact written in two steps shows both versions, the selector switches, restore creates a new one", async () => {
    await boot([["page.html", "html", ["<h1>First</h1>", "<h1>Second</h1>"]]]);
    await open("page.html");
    const select = (await screen.findByTestId("art-version")) as HTMLSelectElement;
    await waitFor(() => expect([...select.options].map((o) => o.textContent)).toEqual(["v1 · agent", "v2 (latest) · agent"]));
    const frame = (await screen.findByTestId("art-frame")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toStartWith("/artifact-view/cap123");
    fireEvent.change(select, { target: { value: "1" } });
    await waitFor(() => expect(fake.calls.some((c) => c.includes("content?preview=1&version=1"))).toBe(true));
    expect(fake.calls.some((c) => c.includes("/view") && c.startsWith("POST"))).toBe(true);
    fireEvent.click(screen.getByTestId("art-mode-code"));
    await waitFor(() => expect(screen.getByTestId("art-code").textContent).toContain("First"));
    fireEvent.click(screen.getByTestId("art-restore"));
    await waitFor(() => expect(fake.files.get("page.html")!.versions).toHaveLength(3));
    expect(fake.files.get("page.html")!.versions[2]).toMatchObject({ text: "<h1>First</h1>", author: "restore" });
  });

  test("the Diff view compares a version with the one before", async () => {
    await boot([["a.md", "markdown", ["one\ntwo", "one\nthree"]]]);
    await open("a.md");
    fireEvent.click(await screen.findByTestId("art-mode-diff"));
    await waitFor(() => expect(screen.getByTestId("diff-view").textContent).toContain("three"));
    expect(screen.getByTestId("diff-view").textContent).toContain("two");
  });
});

describe("renderers", () => {
  const cases: Array<[string, ArtifactKind, string, string]> = [
    ["a.md", "markdown", "# Title\n\ntext", "art-md"],
    ["a.ts", "code", "const x = 1;", "art-code"],
    ["a.txt", "text", "plain words", "art-code"],
    ["a.json", "json", '{"a":{"b":[1,2]}}', "art-tree"],
    ["a.csv", "csv", 'x,y\n1,"2,5"', "art-table"],
    ["a.mmd", "mermaid", "graph TD; A-->B", "art-mermaid"],
    ["a.svg", "svg", '<svg xmlns="http://www.w3.org/2000/svg"/>', "art-body"],
    ["a.tsx", "tsx", "export const A = () => null;", "art-tsx-note"],
  ];
  for (const [name, kind, text, id] of cases) {
    test(`${kind}: ${name} shows ${id}`, async () => {
      await boot([[name, kind, [text]]]);
      await open(name);
      await waitFor(() => expect(screen.getByTestId(id)).toBeTruthy());
      if (kind === "svg") {
        expect(screen.getByTestId("art-img").getAttribute("src")).toStartWith("blob:");
      }
    });
  }

  test("json shows a tree and csv a table with a quoted comma kept in its cell", async () => {
    expect(parseCsv('x,y\n1,"2,5"\n"a ""q""",b\r\n')).toEqual([["x", "y"], ["1", "2,5"], ['a "q"', "b"]]);
    await boot([["a.csv", "csv", ["x,y\n1,2"]]]);
    await open("a.csv");
    await waitFor(() => expect(screen.getByTestId("art-table").querySelectorAll("tbody td").length).toBe(2));
  });

  test("a PDF shows in an iframe of the blob, an unknown type offers a download only", async () => {
    await boot([["a.pdf", "pdf", ["%PDF-1.4"]], ["a.bin", "unknown", ["x"]]]);
    await open("a.pdf");
    await waitFor(() => expect(screen.getByTestId("art-pdf").getAttribute("src")).toBe("blob:test"));
    fireEvent.change(screen.getByTestId("art-switch"), { target: { value: "a.bin" } });
    await waitFor(() => expect(screen.getByText(/no preview/)).toBeTruthy());
    expect(screen.queryByTestId("art-mode-code")).toBeNull();
  });

  test("React code is shown as code with a note, and several artifacts give tabs and a switcher", async () => {
    await boot([["a.tsx", "tsx", ["x"]], ["b.md", "markdown", ["y"]]]);
    await open("a.tsx");
    expect(screen.getByTestId("art-tabs").querySelectorAll("[role=tab]").length).toBe(2);
    expect((screen.getByTestId("art-switch") as HTMLSelectElement).options.length).toBe(2);
    await waitFor(() => expect(screen.getByTestId("art-tsx-note").textContent).toContain("No bundler"));
  });

  test("a failed load shows the server's reason", async () => {
    await boot([["a.md", "markdown", ["x"]]]);
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes("/content") ? new Response(JSON.stringify({ error: "a.md: larger than 5 MB, download it instead" }), { status: 413 }) : orig(input, init))) as typeof fetch;
    await open("a.md");
    await waitFor(() => expect(screen.getByTestId("art-error").textContent).toContain("larger than 5 MB"));
  });
});

describe("talking about an artifact", () => {
  test("Ask about this adds a chip, and the message gets the path, version, hash and the edit-in-place instruction", async () => {
    await boot([["a.md", "markdown", ["# hi"]]]);
    await open("a.md");
    await waitFor(() => expect(screen.getByTestId("art-md")).toBeTruthy());
    fireEvent.click(screen.getByTestId("art-ask"));
    expect(screen.getByTestId("art-chip").textContent).toContain("@a.md v1");
    let text = "";
    act(() => { text = last!.compose("make it shorter"); });
    expect(text).toStartWith("make it shorter\n\nArtifact reference:");
    expect(text).toContain(`/work/.orch/chats/c1/artifacts/a.md (v1, hash ${hashOf("# hi")})`);
    expect(text).toContain("Edit the file in place");
    expect(screen.queryByTestId("art-chip")).toBeNull();
  });

  test("an @name in the text becomes a reference without a chip", async () => {
    await boot([["a.md", "markdown", ["# hi"]], ["b.html", "html", ["<p>"]]]);
    let text = "";
    act(() => { text = last!.compose("fix @b.html, then @a.md please"); });
    expect(text).toContain("artifacts/b.html (v1");
    expect(text).toContain("artifacts/a.md (v1");
    expect(mentionedNames("mail me@a.md", ["a.md"])).toEqual([]);
    expect(refBlock([{ name: "x.ts", version: 2, hash: "ab", quote: "l1\nl2", lines: [3, 4] }], "/d")).toContain("(v2, hash ab, lines 3-4)\n> l1\n> l2");
  });

  test("selecting text in a code artifact shows Comment, which quotes the lines into the next message", async () => {
    await boot([["a.ts", "code", ["alpha\nbeta\ngamma"]]]);
    await open("a.ts");
    await waitFor(() => expect(screen.getByTestId("art-code").textContent).toContain("gamma"));
    const lines = document.querySelectorAll(".art-lc");
    const range = document.createRange();
    range.setStart(lines[0]!.firstChild!, 0);
    range.setEnd(lines[1]!.firstChild!, 4);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const info = selectionInfo(screen.getByTestId("art-body"));
    expect(info?.lines).toEqual([1, 2]);
    expect(info?.quote).toContain("beta");
    await act(async () => { document.dispatchEvent(new Event("selectionchange")); });
    fireEvent.click(await screen.findByTestId("art-comment"));
    expect(screen.getByTestId("art-chip").textContent).toContain("L1-2");
    let text = "";
    act(() => { text = last!.compose("why?"); });
    expect(text).toContain("lines 1-2");
    expect(text).toContain("> alpha");
  });
});

describe("editing", () => {
  test("Edit saves a new version from the textarea with the hash it started from", async () => {
    await boot([["a.md", "markdown", ["old"]]]);
    await open("a.md");
    fireEvent.click(await screen.findByTestId("art-mode-edit"));
    const area = screen.getByTestId("art-edit") as HTMLTextAreaElement;
    await waitFor(() => expect(area.value).toBe("old"));
    fireEvent.change(area, { target: { value: "new text" } });
    const orig = globalThis.fetch;
    let body = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        body = String(init.body);
        return new Response(JSON.stringify({}));
      }
      return orig(input, init);
    }) as typeof fetch;
    fireEvent.click(screen.getByTestId("art-save"));
    await waitFor(() => expect(JSON.parse(body)).toEqual({ content: "new text", base_hash: hashOf("old") }));
  });

  test("a conflicting save keeps the draft and shows the error", async () => {
    await boot([["a.md", "markdown", ["old"]]]);
    await open("a.md");
    fireEvent.click(await screen.findByTestId("art-mode-edit"));
    fireEvent.change(screen.getByTestId("art-edit"), { target: { value: "mine" } });
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => (init?.method === "PUT" ? new Response(JSON.stringify({ error: "the artifact changed since you opened it" }), { status: 409 }) : orig(input, init))) as typeof fetch;
    fireEvent.click(screen.getByTestId("art-save"));
    await waitFor(() => expect(screen.getByTestId("art-save-error").textContent).toContain("changed since"));
    expect((screen.getByTestId("art-edit") as HTMLTextAreaElement).value).toBe("mine");
  });
});
