import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, waitFor, within } = await import("@testing-library/react");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { ConfirmProvider } = await import("../components/ConfirmDialog");
const { queryClient, dropEtags } = await import("../api/queries");
const { ProfilesPage } = await import("./ProfilesPage");
const { HarnessesPage, withSavedEnabled } = await import("./HarnessesPage");
const { nextChoice, profileUseState, usageBadge } = await import("../lib/usage-ui");

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  queryClient.clear();
  dropEtags();
  globalThis.fetch = realFetch;
  localStorage.clear();
});
afterAll(uninstall);

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const harness = (id: string, usage?: string[]) => ({ id, kind: "cli", binary: id, wired: true, description: `${id} cli`, needs: [], enabled: true, available: true, reason: "", ...(usage ? { usage } : {}) });

function docOf(over: Record<string, unknown> = {}) {
  return {
    settings: { default_profile: "both", ...(over["settings"] as object | undefined) },
    models: {},
    profiles: {
      both: { harness: "claude" },
      "chat-only": { harness: "claude", usage: ["chat"] },
      "runs-only": { harness: "claude", usage: ["runs"] },
      oc: { harness: "opencode" },
    },
  };
}

interface Call { method: string; url: string; body: unknown }

function serve(document: unknown, harnesses: unknown[], onPatch: () => Response = () => json(200, { id: "x", usage: ["chat"] })): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (method === "PATCH") return Promise.resolve(onPatch());
    if (url.endsWith("/profiles")) return Promise.resolve(json(200, { document, issues: [], limits: { max_body_bytes: 1 }, harnesses: ["claude", "opencode"] }));
    if (url.includes("/harnesses")) return Promise.resolve(json(200, { probed_at: "2026-11-16T10:00:00Z", harnesses }));
    return Promise.resolve(json(200, {}));
  }) as typeof fetch;
  return calls;
}

const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={queryClient}><ToastProvider><ConfirmProvider>{ui}</ConfirmProvider></ToastProvider></QueryClientProvider>);

describe("usage helpers", () => {
  const d = docOf({ settings: { harness_usage: { opencode: ["runs"] } } }) as never;
  test("a chip is on only when the profile and its harness allow the use", () => {
    expect(profileUseState(d, "oc", "chat")).toMatchObject({ on: false, own: true });
    expect(profileUseState(d, "oc", "chat").lock).toContain("Chat is off for the opencode harness");
    expect(profileUseState(d, "chat-only", "runs").on).toBe(false);
    expect(profileUseState(d, "chat-only", "runs").lock).toBeNull();
  });
  test("the last use cannot be switched off", () => {
    expect(nextChoice(["chat"], "chat", false)).toBeNull();
    expect(nextChoice(["chat", "runs"], "chat", false)).toBe("runs");
    expect(nextChoice(["runs"], "chat", true)).toBe("both");
  });
  test("badges only for a limited use", () => {
    expect(usageBadge(["chat", "runs"])).toBeNull();
    expect(usageBadge(["chat"])).toBe("Chat only");
    expect(usageBadge(["runs"])).toBe("Orch runs only");
  });
  test("withSavedEnabled shows the saved harness usage at once", () => {
    const out = withSavedEnabled([harness("opencode") as never], d);
    expect(out[0]?.usage).toEqual(["runs"]);
  });
});

describe("Profiles page", () => {
  test("each row has Chat and Orch runs switches reflecting the saved usage", async () => {
    serve(docOf(), []);
    wrap(<ProfilesPage />);
    const chat = await screen.findByRole("switch", { name: "Chat for chat-only" });
    expect(chat.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Orch runs for chat-only" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Orch runs for runs-only" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Chat only")).toBeTruthy();
    expect(screen.getByText("Orch runs only")).toBeTruthy();
  });

  test("a switch saves at once with PATCH and a toast", async () => {
    const calls = serve(docOf(), [], () => json(200, { id: "both", usage: ["runs"] }));
    wrap(<ProfilesPage />);
    fireEvent.click(await screen.findByRole("switch", { name: "Chat for both" }));
    await screen.findByText(/both: no longer Chat/);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toEndWith("/profiles/both/usage");
    expect(patch?.body).toEqual({ usage: "runs" });
  });

  test("the last remaining use is locked", async () => {
    serve(docOf(), []);
    wrap(<ProfilesPage />);
    const only = await screen.findByRole("switch", { name: "Chat for chat-only" });
    expect((only as HTMLButtonElement).disabled).toBe(true);
    expect(only.getAttribute("title")).toBe("At least one use must stay on");
  });

  test("a harness that is off for a use disables its profiles' switch with a one-line reason", async () => {
    serve(docOf({ settings: { harness_usage: { opencode: ["runs"] } } }), []);
    wrap(<ProfilesPage />);
    const chat = await screen.findByRole("switch", { name: "Chat for oc" });
    expect((chat as HTMLButtonElement).disabled).toBe(true);
    expect(chat.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Chat is off for the opencode harness. Change it on the Harnesses page.")).toBeTruthy();
  });

  test("the filter keeps only profiles available for the chosen use", async () => {
    serve(docOf(), []);
    wrap(<ProfilesPage />);
    await screen.findByRole("switch", { name: "Chat for both" });
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.queryByRole("switch", { name: "Chat for runs-only" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Chat for chat-only" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Orch runs" }));
    expect(screen.queryByRole("switch", { name: "Chat for chat-only" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Chat for runs-only" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByRole("switch", { name: "Chat for chat-only" })).toBeTruthy();
  });

  test("a failed save shows the server message", async () => {
    serve(docOf(), [], () => json(400, { error: "nope" }));
    wrap(<ProfilesPage />);
    fireEvent.click(await screen.findByRole("switch", { name: "Chat for both" }));
    await screen.findByText(/nope|Could not save/);
  });
});

describe("Harnesses page", () => {
  test("cards carry the badge and switches, and a switch saves via PATCH", async () => {
    const calls = serve(docOf({ settings: { harness_usage: { opencode: ["chat"] } } }), [harness("claude"), harness("opencode", ["chat"])], () => json(200, { id: "claude", usage: ["runs"] }));
    wrap(<HarnessesPage />);
    expect(await screen.findByText("Chat only")).toBeTruthy();
    const opencodeChat = screen.getByRole("switch", { name: "Chat for opencode" });
    expect((opencodeChat as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Chat for claude" }));
    await waitFor(() => { expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/harnesses/claude/usage")).valueOf()).toBe(true); });
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ usage: "runs" });
  });

  test("the filter hides harnesses that are off for the use", async () => {
    serve(docOf({ settings: { harness_usage: { opencode: ["chat"] } } }), [harness("claude"), harness("opencode", ["chat"])]);
    wrap(<HarnessesPage />);
    await screen.findByText("Chat only");
    fireEvent.click(screen.getByRole("button", { name: "Orch runs" }));
    const cards = document.querySelectorAll(".harness-card");
    expect(cards.length).toBe(1);
    expect(within(cards[0] as HTMLElement).getByText("claude")).toBeTruthy();
  });
});
