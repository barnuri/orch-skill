import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { ProfilesDocument } from "../../shared/types/profiles-document";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { api } = await import("../api/client");
const { chatSettingsApi } = await import("../api/chat-settings");
const { SettingsForm } = await import("./SettingsForm");
const { applyChatDraft, chatDraftFrom } = await import("./ChatSettingsFields");
const { chatRootsProblem, graceHoursProblem, parseRootsText } = await import("../../shared/chat-settings");

const realInfo = api.getServerInfo.bind(api);
const realHint = { ...chatSettingsApi };
afterEach(() => {
  cleanup();
  api.getServerInfo = realInfo;
  Object.assign(chatSettingsApi, realHint);
});
afterAll(uninstall);

const doc = (settings: Record<string, unknown> = {}): ProfilesDocument => ({ settings: { default_profile: "main", ...settings }, models: {}, profiles: { main: { harness: "claude", model: "m" } } }) as unknown as ProfilesDocument;
const ok = <T,>(body: T) => ({ kind: "ok" as const, body, etag: null });

function mount(document: ProfilesDocument, hint = true) {
  const saved: unknown[] = [];
  let dirty = 0;
  api.getServerInfo = (async () => ok({ https_port: 0, https_listening: false, https_url: null, trust_path: null, cert_source: null, cert_expires: null, problem: null, secure_link_hint: hint })) as typeof api.getServerInfo;
  const editor = { fieldIssues: [], saving: false, markDirty: () => { dirty += 1; }, save: async (next: unknown) => { saved.push(next); return true; } };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ToastProvider><SettingsForm doc={document} editor={editor as never} /></ToastProvider></QueryClientProvider>);
  return { saved, dirty: () => dirty };
}

describe("chat settings rules", () => {
  test("grace hours: empty is the default, 0 to 72 whole numbers pass", () => {
    expect(graceHoursProblem("")).toBeNull();
    expect(graceHoursProblem("0")).toBeNull();
    expect(graceHoursProblem("72")).toBeNull();
    for (const bad of ["73", "-1", "1.5", "six"]) {
      expect(graceHoursProblem(bad)).toBe("Enter a whole number from 0 to 72.");
    }
  });

  test("roots: one per line, absolute or ~/, no ..", () => {
    expect(parseRootsText("~/a\n\n  /b  \n")).toEqual(["~/a", "/b"]);
    expect(chatRootsProblem(["~/a", "/b"])).toBeNull();
    expect(chatRootsProblem(["rel"])).toContain("absolute path");
    expect(chatRootsProblem(["/a/../b"])).toContain("..");
  });

  test("an empty draft leaves the keys out; set values are written", () => {
    const settings: Record<string, unknown> = { schedule_grace_hours: 3, monitor_allow_link_local: true, chat_roots: ["/x"] };
    applyChatDraft(settings, { graceHours: "", allowLinkLocal: false, roots: "" }, []);
    expect(settings).toEqual({});
    applyChatDraft(settings, { graceHours: "0", allowLinkLocal: true, roots: "/a" }, ["/a"]);
    expect(settings).toEqual({ schedule_grace_hours: 0, monitor_allow_link_local: true, chat_roots: ["/a"] });
    expect(chatDraftFrom(settings)).toEqual({ graceHours: "0", allowLinkLocal: true, roots: "/a" });
  });
});

describe("Settings page, Chat section", () => {
  test("shows the four fields with their defaults and the link-local warning", async () => {
    mount(doc());
    const section = screen.getByTestId("chat-settings");
    expect(section.querySelector("h3")?.textContent).toBe("Chat");
    const grace = screen.getByLabelText("Missed schedule grace (hours)") as HTMLInputElement;
    expect(grace.value).toBe("");
    expect(grace.placeholder).toBe("6");
    expect((screen.getByTestId("link-local") as HTMLInputElement).checked).toBe(false);
    expect(section.textContent).toContain("cloud metadata endpoints");
    expect((screen.getByLabelText("Chat folders") as HTMLTextAreaElement).placeholder).toBe("~/sandbox/private");
    await waitFor(() => { expect((screen.getByTestId("secure-link-hint") as HTMLInputElement).checked).toBe(true); });
  });

  test("Save writes the three keys into the document settings", () => {
    const m = mount(doc());
    fireEvent.change(screen.getByLabelText("Missed schedule grace (hours)"), { target: { value: "24" } });
    fireEvent.click(screen.getByTestId("link-local"));
    fireEvent.change(screen.getByLabelText("Chat folders"), { target: { value: "~/sandbox/private\n/srv/work" } });
    expect(m.dirty()).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(m.saved).toHaveLength(1);
    expect((m.saved[0] as ProfilesDocument).settings).toMatchObject({ schedule_grace_hours: 24, monitor_allow_link_local: true, chat_roots: ["~/sandbox/private", "/srv/work"] });
  });

  test("values already in the document are shown, and clearing a box removes its key", () => {
    const m = mount(doc({ schedule_grace_hours: 2, monitor_allow_link_local: true, chat_roots: ["/a", "/b"] }));
    expect((screen.getByLabelText("Missed schedule grace (hours)") as HTMLInputElement).value).toBe("2");
    expect((screen.getByTestId("link-local") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Chat folders") as HTMLTextAreaElement).value).toBe("/a\n/b");
    fireEvent.change(screen.getByLabelText("Missed schedule grace (hours)"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("link-local"));
    fireEvent.change(screen.getByLabelText("Chat folders"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const settings = (m.saved[0] as ProfilesDocument).settings as Record<string, unknown>;
    expect("schedule_grace_hours" in settings).toBe(false);
    expect("monitor_allow_link_local" in settings).toBe(false);
    expect("chat_roots" in settings).toBe(false);
  });

  test("an invalid number or folder blocks the save and says why under the field", () => {
    const m = mount(doc());
    fireEvent.change(screen.getByLabelText("Missed schedule grace (hours)"), { target: { value: "99" } });
    fireEvent.change(screen.getByLabelText("Chat folders"), { target: { value: "relative/path" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(m.saved).toHaveLength(0);
    expect(screen.getByTestId("grace-error").textContent).toBe("Enter a whole number from 0 to 72.");
    expect(screen.getByTestId("roots-error").textContent).toContain("must be an absolute path");
    fireEvent.change(screen.getByLabelText("Missed schedule grace (hours)"), { target: { value: "5" } });
    expect(screen.queryByTestId("grace-error")).toBeNull();
  });

  test("the secure-link switch saves at once through its own call and reports a failure", async () => {
    const calls: boolean[] = [];
    Object.assign(chatSettingsApi, { setSecureLinkHint: async (v: boolean) => { calls.push(v); return ok({ secure_link_hint: v }); } });
    mount(doc());
    const box = (await waitFor(() => { const b = screen.getByTestId("secure-link-hint") as HTMLInputElement; expect(b.disabled).toBe(false); return b; }));
    fireEvent.click(box);
    await waitFor(() => { expect(calls).toEqual([false]); });
  });
});
