import { afterAll, afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom } from "../test/dom";
import type { Chat } from "../lib/chat-types";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { chatsApi } = await import("../api/chats");
const { ToastProvider } = await import("../components/Toast");
const { SubfolderField } = await import("./SubfolderField");
const { FolderChip } = await import("./FolderPicker");
const { ChatListRow } = await import("./ChatListRow");

const realApi = { ...chatsApi };
afterEach(() => {
  cleanup();
  Object.assign(chatsApi, realApi);
});
afterAll(uninstall);

const ok = <T,>(body: T) => ({ kind: "ok" as const, body, etag: null });
const PROJECT = "/Users/me/sandbox/private/app";

function field(value: string | null, onSave: (next: string | null) => Promise<string | null>) {
  const asked: Array<[string | undefined, number | undefined]> = [];
  Object.assign(chatsApi, {
    folders: async (root?: string, depth?: 1 | 2) => {
      asked.push([root, depth]);
      return ok({ root: PROJECT, roots: [PROJECT], truncated: false, items: [{ path: `${PROJECT}/docs`, name: "docs", last_used_at: null }, { path: `${PROJECT}/docs/api`, name: "docs/api", last_used_at: null }] });
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><SubfolderField projectPath={PROJECT} value={value} onSave={onSave} /></QueryClientProvider>);
  return asked;
}

test("the field suggests existing folders (depth 2), shows the path quietly and saves on blur and on Enter", async () => {
  const saved: Array<string | null> = [];
  const asked = field(null, async (next) => { saved.push(next); return null; });
  await waitFor(() => { expect(document.querySelectorAll("datalist option").length).toBe(2); });
  expect(asked[0]).toEqual([PROJECT, 2]);
  expect(Array.from(document.querySelectorAll("datalist option")).map((o) => o.getAttribute("value"))).toEqual(["docs", "docs/api"]);
  expect(screen.getByTestId("subfolder-path").textContent).toBe(PROJECT);

  const input = screen.getByLabelText("Subfolder") as HTMLInputElement;
  fireEvent.change(input, { target: { value: " docs//api/ " } });
  expect(screen.getByTestId("subfolder-path").textContent).toBe(`${PROJECT}/docs/api`);
  fireEvent.blur(input);
  await waitFor(() => { expect(saved).toEqual(["docs/api"]); });

  fireEvent.change(input, { target: { value: "other" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => { expect(saved).toEqual(["docs/api", "other"]); });
});

test("a bad value is explained in a sentence under the field and is not sent; a server error shows too", async () => {
  const saved: Array<string | null> = [];
  field(null, async (next) => { saved.push(next); return "subfolder: resolves outside the project folder"; });
  const input = screen.getByLabelText("Subfolder");
  fireEvent.change(input, { target: { value: "../x" } });
  fireEvent.blur(input);
  await waitFor(() => { expect(screen.getByTestId("subfolder-error").textContent).toMatch(/^Must not contain empty, \. or \.\. segments\.$/); });
  expect(saved).toEqual([]);
  expect(screen.getByRole("alert")).toBeTruthy();

  fireEvent.change(input, { target: { value: "link" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => { expect(screen.getByTestId("subfolder-error").textContent).toBe("Resolves outside the project folder."); });
  expect(saved).toEqual(["link"]);
});

test("Clear saves null", async () => {
  const saved: Array<string | null> = [];
  field("docs", async (next) => { saved.push(next); return null; });
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  await waitFor(() => { expect(saved).toEqual([null]); });
});

test("the chip shows project / subfolder, and the list row carries it", () => {
  render(<FolderChip path={`${PROJECT}/docs/api`} subfolder="docs/api" inherited />);
  expect(screen.getByTestId("folder-chip").textContent).toContain("app / docs/api");
  cleanup();
  const chat = { id: "c", project_id: "p", title: "T", harness: "claude", profile: "main", model_id: null, session_id: null, status: "idle", created_at: "a", updated_at: "b", archived_at: null, cwd: null, subfolder: "docs", effective_cwd: `${PROJECT}/docs` } as Chat;
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><ToastProvider><ChatListRow chat={chat} href="#/x" meta="claude" /></ToastProvider></QueryClientProvider>);
  expect(screen.getByTestId("folder-chip").textContent).toContain("app / docs");
});

test("the field has 44px targets on phones and the error is the only red", () => {
  const css = readFileSync(join(import.meta.dir, "chats.css"), "utf8");
  expect(css).toMatch(/@media \(max-width: 768px\)[^{]*\{\s*\.subfolder-input, \.subfolder-clear \{ min-height: 44px; \}/);
  expect(css).toMatch(/\.subfolder-error \{ color: var\(--status-error\)/);
});
