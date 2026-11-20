import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";
import type { Chat, Project } from "../lib/chat-types";
import { projectLabel, projectOptions, projectTree } from "../lib/project-tree";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { chatsApi } = await import("../api/chats");
const { Sidebar } = await import("./Sidebar");
const { ProjectView } = await import("./ProjectView");

const realApi = { ...chatsApi };
afterEach(() => {
  cleanup();
  Object.assign(chatsApi, realApi);
});
afterAll(uninstall);

const ok = <T,>(body: T) => ({ kind: "ok" as const, body, etag: null });
const prj = (id: string, name: string, over: Partial<Project> = {}): Project => ({ id, name, path: null, description: "", created_at: "a", archived_at: null, parent_id: null, ...over });
const chat = (id: string, projectId: string | null, title: string): Chat => ({ id, project_id: projectId, title, harness: "claude", profile: "main", model_id: null, session_id: null, status: "idle", created_at: "a", updated_at: "b", archived_at: null, cwd: null, effective_cwd: null }) as Chat;

const HOME = prj("prj-2", "home tasks", { path: "/home/tasks" });
const OTHER = prj("prj-1", "other");
const OVEN = prj("prj-4", "oven", { parent_id: "prj-2", path: "/home/tasks/oven" });
const FRIDGE = prj("prj-3", "fridge", { parent_id: "prj-2", path: "/home/tasks/fridge" });
const ORPHAN = prj("prj-5", "orphan", { parent_id: "prj-gone" });

describe("projectTree", () => {
  test("each parent is followed by its sub projects, oldest first; an orphan stays top level", () => {
    const tree = projectTree([ORPHAN, OVEN, HOME, FRIDGE, OTHER]);
    expect(tree.map((n) => [n.project.id, n.depth])).toEqual([["prj-5", 0], ["prj-2", 0], ["prj-3", 1], ["prj-4", 1], ["prj-1", 0]]);
  });
  test("labels and select options name the parent", () => {
    const all = [HOME, OVEN, OTHER, ORPHAN];
    expect(projectLabel(OVEN, all)).toBe("home tasks / oven");
    expect(projectLabel(ORPHAN, all)).toBe("orphan");
    expect(projectOptions(all)).toEqual([{ value: "prj-2", label: "home tasks" }, { value: "prj-4", label: "home tasks / oven" }, { value: "prj-1", label: "other" }, { value: "prj-5", label: "orphan" }]);
  });
});

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ToastProvider>{node}</ToastProvider></QueryClientProvider>);
}

describe("sub projects in the UI", () => {
  test("the sidebar nests each sub project, with its one chat, under its parent", async () => {
    Object.assign(chatsApi, {
      projects: async () => ok({ items: [OVEN, HOME, FRIDGE], next_cursor: null }),
      chats: async () => ok({ items: [chat("chat-a", "prj-3", "Fridge chat"), chat("chat-b", "prj-4", "Oven chat")], next_cursor: null }),
      search: async () => ok({ items: [] }),
    });
    wrap(<Sidebar activeChatId={null} activeProjectId={null} options={undefined} onNavigate={() => undefined} />);
    await screen.findByText("Fridge chat");
    const heads = Array.from(document.querySelectorAll(".group-head a")).map((a) => a.textContent);
    expect(heads).toEqual(["home tasks", "fridge", "oven"]);
    const subs = screen.getAllByTestId("sub-project-group");
    expect(subs.map((s) => s.querySelector(".group-head a")?.textContent)).toEqual(["fridge", "oven"]);
    expect(subs[0]?.textContent).toContain("Fridge chat");
    expect(subs[1]?.textContent).toContain("Oven chat");
  });

  test("a project page lists its sub projects and creates one under it", async () => {
    const created: unknown[] = [];
    Object.assign(chatsApi, {
      projects: async () => ok({ items: [HOME, FRIDGE], next_cursor: null }),
      chats: async () => ok({ items: [], next_cursor: null }),
      createProject: async (body: unknown) => {
        created.push(body);
        return ok(prj("prj-9", "garden", { parent_id: "prj-2" }));
      },
    });
    wrap(<ProjectView projectId="prj-2" onOpenDrawer={() => undefined} />);
    await waitFor(() => { expect(screen.getByTestId("subproject-list").textContent).toContain("fridge"); });
    fireEvent.change(screen.getByLabelText("Sub project name"), { target: { value: " garden " } });
    fireEvent.click(screen.getByRole("button", { name: "New sub project" }));
    await waitFor(() => { expect(created).toEqual([{ name: "garden", parent_id: "prj-2" }]); });
    await waitFor(() => { expect(location.hash).toBe("#/projects/prj-9"); });
  });

  test("a sub project page names its parent and offers no nested sub projects", async () => {
    Object.assign(chatsApi, {
      projects: async () => ok({ items: [HOME, FRIDGE], next_cursor: null }),
      chats: async () => ok({ items: [], next_cursor: null }),
    });
    wrap(<ProjectView projectId="prj-3" onOpenDrawer={() => undefined} />);
    await waitFor(() => { expect(screen.getByTestId("project-parent").textContent).toBe("Sub project of home tasks"); });
    expect(screen.queryByLabelText("Sub project name")).toBeNull();
  });

  test("a failed create shows the reason", async () => {
    Object.assign(chatsApi, {
      projects: async () => ok({ items: [HOME], next_cursor: null }),
      chats: async () => ok({ items: [], next_cursor: null }),
      createProject: async () => ({ kind: "error" as const, status: 400, body: { error: "subfolder: a sub project name without a path must be one folder name (no /)" }, etag: null }),
    });
    wrap(<ProjectView projectId="prj-2" onOpenDrawer={() => undefined} />);
    fireEvent.change(await screen.findByLabelText("Sub project name"), { target: { value: "a/b" } });
    fireEvent.click(screen.getByRole("button", { name: "New sub project" }));
    await waitFor(() => { expect(document.querySelector("#toasts")?.textContent).toContain("one folder name"); });
  });
});
