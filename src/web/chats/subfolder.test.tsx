import { afterAll, afterEach, expect, test } from "bun:test";
import { installDom } from "../test/dom";
import type { Chat } from "../lib/chat-types";

const uninstall = installDom();
const { render, screen, cleanup } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { FolderChip } = await import("./FolderPicker");
const { ChatListRow } = await import("./ChatListRow");

afterEach(cleanup);
afterAll(uninstall);

const PROJECT = "/Users/me/sandbox/private/app";

// Sub projects replaced the Subfolder field; a chat that still has a subfolder (not migrated yet) keeps showing it on its chip.
test("the chip shows project / subfolder, and the list row carries it", () => {
  render(<FolderChip path={`${PROJECT}/docs/api`} subfolder="docs/api" inherited />);
  expect(screen.getByTestId("folder-chip").textContent).toContain("app / docs/api");
  cleanup();
  const chat = { id: "c", project_id: "p", title: "T", harness: "claude", profile: "main", model_id: null, session_id: null, status: "idle", created_at: "a", updated_at: "b", archived_at: null, cwd: null, subfolder: "docs", effective_cwd: `${PROJECT}/docs` } as Chat;
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><ToastProvider><ChatListRow chat={chat} href="#/x" meta="claude" /></ToastProvider></QueryClientProvider>);
  expect(screen.getByTestId("folder-chip").textContent).toContain("app / docs");
});

test("the start page and the chat settings no longer offer a Subfolder field", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  for (const file of ["StartPage.tsx", "ChatView.tsx"]) {
    expect(readFileSync(join(import.meta.dir, file), "utf8")).not.toContain("SubfolderField");
  }
});
