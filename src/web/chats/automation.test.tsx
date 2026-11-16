import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";
import type { Message } from "../lib/chat-types";
import type { ChatLoop, ChatMonitor } from "../../shared/types/chat-automation";
import type { Schedule } from "../../shared/types/schedule";

const uninstall = installDom();
for (const k of ["location", "history", "sessionStorage", "localStorage", "ResizeObserver", "matchMedia"] as const) {
  const w = window as unknown as Record<string, unknown>;
  if (w[k] !== undefined && (globalThis as Record<string, unknown>)[k] === undefined) {
    Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
  }
}
const { render, screen, fireEvent, cleanup, waitFor, within } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { ConfirmProvider } = await import("../components/ConfirmDialog");
const { automationApi } = await import("../api/automation");
const { AutomationButton, AutomationHost } = await import("./AutomationSheet");
const { useAutomation } = await import("./automation-context");
const { MessageView } = await import("./MessageView");
const { Composer } = await import("./Composer");
const logic = await import("./automation-logic");
const { ChatListRow } = await import("./ChatListRow");

const real = { ...automationApi };
afterEach(() => {
  cleanup();
  Object.assign(automationApi, real);
});
afterAll(uninstall);

const ok = <T,>(body: T) => ({ kind: "ok" as const, body, etag: null });
const sched = (over: Partial<Schedule> = {}): Schedule => ({
  id: "sch-1", name: "Morning news", cron: "0 9 * * 1-5", kind: "prompt", enabled: true, created_at: "2026-11-16T00:00:00Z", prompt: "Summarise the news", profile: null, command: null, workdir: null, timeout: 0,
  next_at: Math.floor(Date.now() / 1000) + 3600, last_run_at: null, last_status: null, runs: [], target: { kind: "chat", chat_id: "chat-1", mode: "message" }, timezone: "UTC", ...over,
});
const loop = (over: Partial<ChatLoop> = {}): ChatLoop => ({ id: "loop-1", label: "Poll build", prompt: "check", mode: "message", status: "running", reason: null, iteration: 2, max: 10, interval: 600, next_tick: Math.floor(Date.now() / 1000) + 300, until: { command: "", regex: "", text: "the build is green" }, last_exit: 0, started: "2026-11-16T00:00:00Z", ended: null, ...over });
const monitor = (over: Partial<ChatMonitor> = {}): ChatMonitor => ({ id: "watch-1", name: "Site", spec: { type: "url", target: "https://example.com", condition: "status" }, interval: 60, status: "running", reason: null, events: 1, last_event: null, once: false, debounce: 0, then: { mode: "tell" }, expires_at: Math.floor(Date.now() / 1000) + 86400, started: "2026-11-16T00:00:00Z", ...over });

interface Fake { schedules: Schedule[]; loops: ChatLoop[]; monitors: ChatMonitor[]; calls: string[] }
function fake(init: Partial<Fake> = {}): Fake {
  const f: Fake = { schedules: [], loops: [], monitors: [], calls: [], ...init };
  Object.assign(automationApi, {
    schedules: async () => ok({ items: f.schedules }),
    loops: async () => ok({ items: f.loops }),
    monitors: async () => ok({ items: f.monitors }),
    createSchedule: async (_c: string, body: unknown) => { f.calls.push(`createSchedule ${JSON.stringify(body)}`); return ok({ id: "sch-new" }); },
    editSchedule: async (_c: string, id: string, body: unknown) => { f.calls.push(`editSchedule ${id} ${JSON.stringify(body)}`); return ok({ ok: true }); },
    deleteSchedule: async (_c: string, id: string) => { f.calls.push(`deleteSchedule ${id}`); return ok({ ok: true }); },
    scheduleAction: async (_c: string, id: string, a: string) => { f.calls.push(`scheduleAction ${id} ${a}`); return ok({ ok: true }); },
    scheduleLog: async () => ok({ entries: [{ at: "2026-11-16T09:00:00Z", status: "failed", text: "model unavailable" }] }),
    createLoop: async (_c: string, body: unknown) => { f.calls.push(`createLoop ${JSON.stringify(body)}`); return ok({ id: "loop-new" }); },
    loopAction: async (_c: string, id: string, a: string) => { f.calls.push(`loopAction ${id} ${a}`); return ok({ ok: true }); },
    loopLog: async () => ok({ entries: [] }),
    createMonitor: async (_c: string, body: unknown) => { f.calls.push(`createMonitor ${JSON.stringify(body)}`); return ok({ id: "watch-new" }); },
    monitorAction: async (_c: string, id: string, a: string) => { f.calls.push(`monitorAction ${id} ${a}`); return ok({ ok: true }); },
    monitorLog: async () => ok({ entries: [] }),
    markRead: async () => ok({ ok: true }),
  });
  return f;
}

function Controls() {
  const a = useAutomation();
  if (a === null) return null;
  return (
    <>
      <AutomationButton api={a} />
      <button type="button" onClick={() => { a.openCreate("schedules", "Check the deploy"); }}>open-create</button>
      <button type="button" onClick={() => { void a.slash((document.getElementById("slash") as HTMLInputElement).value).then((r) => { document.body.setAttribute("data-slash", String(r)); }); }}>run-slash</button>
      <input id="slash" defaultValue="" />
    </>
  );
}

function mount(children: React.ReactNode = <Controls />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ConfirmProvider>
          <AutomationHost chatId="chat-1">{children}</AutomationHost>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const slash = async (text: string): Promise<string> => {
  (document.getElementById("slash") as HTMLInputElement).value = text;
  document.body.removeAttribute("data-slash");
  fireEvent.click(screen.getByText("run-slash"));
  await waitFor(() => expect(document.body.getAttribute("data-slash")).not.toBeNull());
  return document.body.getAttribute("data-slash") as string;
};

describe("logic", () => {
  test("presets give the cron, the plain text and the next three runs", () => {
    const d = { ...logic.emptyScheduleDraft("Summarise"), timezone: "UTC" };
    expect(logic.draftCron({ ...d, preset: "daily" })).toBe("0 9 * * *");
    expect(logic.draftCron({ ...d, preset: "weekdays" })).toBe("0 9 * * 1-5");
    expect(logic.draftCron({ ...d, preset: "sunday" })).toBe("0 9 * * 0");
    expect(logic.draftCron({ ...d, preset: "hourly" })).toBe("0 * * * *");
    expect(logic.draftCron({ ...d, preset: "once", once: "2026-12-24T18:30" })).toBe("30 18 24 12 *");
    expect(logic.draftCron({ ...d, preset: "custom", custom: "*/10 * * * *" })).toBe("*/10 * * * *");
    const p = logic.previewOf({ ...d, preset: "weekdays" }, Date.parse("2026-11-14T00:00:00Z") / 1000);
    expect(p.text).toContain("09:00");
    expect(p.runs).toHaveLength(3);
    expect(p.error).toBeNull();
  });

  test("preview and body refuse an empty prompt, a missing date, a bad cron, a cron under 5 minutes and a bad zone", () => {
    const d = { ...logic.emptyScheduleDraft("x"), timezone: "UTC" };
    expect(logic.scheduleBody({ ...d, prompt: "" }).errors.prompt).toBeDefined();
    expect(logic.scheduleBody({ ...d, preset: "once", once: "" }).errors.when).toMatch(/date/);
    expect(logic.scheduleBody({ ...d, preset: "custom", custom: "99 * * * *" }).body).toBeNull();
    expect(logic.scheduleBody({ ...d, preset: "custom", custom: "* * * * *" }).errors.when).toMatch(/5 minutes/);
    expect(logic.scheduleBody({ ...d, timezone: "Mars/Base" }).errors.timezone).toBeDefined();
    const good = logic.scheduleBody({ ...d, preset: "once", once: "2099-01-02T03:04", mode: "fresh" });
    expect(good.body).toMatchObject({ cron: "4 3 2 1 *", mode: "fresh", once: true, timezone: "UTC" });
  });

  test("loop and monitor bodies validate; a URL monitor refuses link-local addresses and under 60 s", () => {
    const l = logic.emptyLoopDraft("check");
    expect(logic.loopBody({ ...l, stopKind: "regex", stop: "(" }).errors.stop).toBeDefined();
    expect(logic.loopBody({ ...l, minutes: "0.05" }).errors.minutes).toBeDefined();
    expect(logic.loopBody({ ...l, cadence: "done", stopKind: "text", stop: "green", max: "" }).body).toMatchObject({ every: 10, until_text: "green" });
    expect(logic.loopBody({ ...l, minutes: "5" }).body).toMatchObject({ every: 300, max: 10, mode: "message" });
    const m = logic.emptyMonitorDraft("http://169.254.169.254/latest", "url");
    expect(logic.monitorBody(m).errors.target).toMatch(/blocked/);
    expect(logic.monitorBody({ ...m, target: "https://example.com", every: "30" }).errors.every).toMatch(/60/);
    expect(logic.monitorBody({ ...m, target: "https://example.com", every: "90" }).body?.spec).toMatchObject({ type: "url", condition: "status" });
    expect(logic.monitorBody({ ...logic.emptyMonitorDraft("a", "command"), condition: "regex", pattern: "" }).errors.pattern).toBeDefined();
    expect(logic.monitorBody({ ...logic.emptyMonitorDraft("a", "file"), every: "5" }).errors.every).toMatch(/10/);
    expect(logic.monitorBody({ ...logic.emptyMonitorDraft("a", "file"), then: "act", thenPrompt: "" }).errors.thenPrompt).toBeDefined();
  });

  test("counts and the live flag", () => {
    expect(logic.activeCounts([sched(), sched({ id: "b", enabled: false })], [loop(), loop({ id: "l2", status: "done" })], [monitor()])).toEqual({ schedules: 1, loops: 1, monitors: 1, total: 3, live: true });
    expect(logic.activeCounts([sched()], [], []).live).toBe(false);
  });
});

describe("header button and list sheet", () => {
  test("the badge counts active items and the sheet opens on Schedules with an empty-state sentence naming the fix", async () => {
    fake();
    mount();
    expect(screen.queryByTestId("automation-count")).toBeNull();
    fireEvent.click(screen.getByTestId("automation-btn"));
    expect(await screen.findByTestId("automation-sheet")).toBeDefined();
    expect(screen.getByTestId("automation-empty").textContent).toContain("/schedule");
    fireEvent.click(screen.getByRole("tab", { name: /Loops/ }));
    expect(screen.getByTestId("automation-empty").textContent).toContain("/loop");
    fireEvent.click(screen.getByRole("tab", { name: /Monitors/ }));
    expect(screen.getByTestId("automation-empty").textContent).toContain("/watch");
  });

  test("badge and live indicator come from the three lists", async () => {
    fake({ schedules: [sched()], loops: [loop()], monitors: [monitor()] });
    mount();
    await waitFor(() => expect(screen.getByTestId("automation-count").textContent).toBe("3"));
    expect(screen.getByLabelText("A loop or monitor is active")).toBeDefined();
  });

  test("a schedule row: summary, next run, enable switch, run now, log, delete with confirm", async () => {
    const f = fake({ schedules: [sched({ runs: [{ started_at: "2026-11-16T09:00:00Z", ended_at: null, kind: "chat", ref: "", status: "failed", exit: null, error: "model unavailable" }], last_status: "failed" })] });
    mount();
    fireEvent.click(screen.getByTestId("automation-btn"));
    const row = await screen.findByTestId("schedule-row");
    expect(row.textContent).toContain("Morning news");
    expect(row.textContent).toContain("Continues this chat");
    expect(row.textContent).toContain("(UTC)");
    expect(row.textContent).toContain("Failed: model unavailable");
    expect(row.textContent).toMatch(/Next in/);
    fireEvent.click(within(row).getByRole("switch", { name: /Pause Morning news/ }));
    await waitFor(() => expect(f.calls).toContain("scheduleAction sch-1 pause"));
    fireEvent.click(within(row).getByText("Run now"));
    await waitFor(() => expect(f.calls).toContain("scheduleAction sch-1 run-now"));
    fireEvent.click(within(row).getByText("Log"));
    expect((await within(row).findByTestId("automation-log")).textContent).toContain("model unavailable");
    fireEvent.click(within(row).getByText("Delete"));
    expect(f.calls.some((c) => c.startsWith("deleteSchedule"))).toBe(false);
    const dialog = await waitFor(() => {
      const d = document.querySelector("dialog.confirm");
      if (d === null) throw new Error("no dialog");
      return d as HTMLDialogElement;
    });
    expect(dialog.textContent).toContain("Delete this schedule?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    dialog.dispatchEvent(new Event("close"));
    await waitFor(() => expect(f.calls).toContain("deleteSchedule sch-1"));
  });

  test("a paused schedule shows why", async () => {
    fake({ schedules: [sched({ enabled: false, next_at: null, pause_reason: "paused after 3 failed runs in a row: boom" })] });
    mount();
    fireEvent.click(screen.getByTestId("automation-btn"));
    expect((await screen.findByTestId("schedule-row")).textContent).toContain("paused after 3 failed runs");
  });

  test("loops tab: progress, stop condition, Stop; a finished loop offers Resume", async () => {
    const f = fake({ loops: [loop(), loop({ id: "loop-2", label: "Old", status: "done", reason: "max", iteration: 10 })] });
    mount();
    fireEvent.click(screen.getByTestId("automation-btn"));
    fireEvent.click(await screen.findByRole("tab", { name: /Loops/ }));
    const rows = await screen.findAllByTestId("loop-row");
    expect(rows[0]!.textContent).toContain("iteration 2 of 10");
    expect(rows[0]!.textContent).toContain("until the build is green");
    fireEvent.click(within(rows[0]!).getByText("Stop"));
    await waitFor(() => expect(f.calls).toContain("loopAction loop-1 stop"));
    expect(rows[1]!.textContent).toContain("reached its maximum");
    expect(within(rows[1]!).queryByText("Stop")).toBeNull();
    fireEvent.click(within(rows[1]!).getByText("Resume"));
    await waitFor(() => expect(f.calls).toContain("loopAction loop-2 resume"));
  });

  test("monitors tab: summary, trigger count, switch, Check now, Stop", async () => {
    const f = fake({ monitors: [monitor()] });
    mount();
    fireEvent.click(screen.getByTestId("automation-btn"));
    fireEvent.click(await screen.findByRole("tab", { name: /Monitors/ }));
    const row = await screen.findByTestId("monitor-row");
    expect(row.textContent).toContain("https://example.com status changes");
    expect(row.textContent).toContain("1 trigger");
    fireEvent.click(within(row).getByRole("switch", { name: /Pause Site/ }));
    await waitFor(() => expect(f.calls).toContain("monitorAction watch-1 pause"));
    fireEvent.click(within(row).getByText("Check now"));
    await waitFor(() => expect(f.calls).toContain("monitorAction watch-1 run-now"));
    fireEvent.click(within(row).getByText("Stop"));
    await waitFor(() => expect(f.calls).toContain("monitorAction watch-1 stop"));
  });
});

describe("creation sheets", () => {
  test("schedule sheet: prefilled prompt, presets change the cron text, next 3 runs, mode help, save sends the body", async () => {
    const f = fake();
    mount();
    fireEvent.click(screen.getByText("open-create"));
    const sheet = await screen.findByTestId("automation-create");
    expect((within(sheet).getByLabelText("What") as HTMLTextAreaElement).value).toBe("Check the deploy");
    expect((within(sheet).getByLabelText("Name") as HTMLInputElement).value).toBe("Check the deploy");
    expect(within(sheet).getByTestId("cron-text").textContent).toContain("09:00");
    expect(within(sheet).getByTestId("schedule-preview").querySelectorAll("li")).toHaveLength(3);
    fireEvent.click(within(sheet).getByRole("button", { name: "Weekdays at 09:00" }));
    expect(within(sheet).getByTestId("cron-text").textContent).toMatch(/Mon|weekday/i);
    fireEvent.click(within(sheet).getByRole("button", { name: "Custom cron" }));
    fireEvent.change(within(sheet).getByLabelText("Cron expression"), { target: { value: "*/10 * * * *" } });
    expect(within(sheet).getByTestId("schedule-preview").textContent).toMatch(/5 minutes|10 minutes/);
    fireEvent.change(within(sheet).getByLabelText("Cron expression"), { target: { value: "30 7 * * 1-5" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Fresh session" }));
    expect(within(sheet).getByTestId("mode-help").textContent).toContain("new session");
    fireEvent.click(within(sheet).getByTestId("automation-save"));
    await waitFor(() => expect(f.calls.some((c) => c.startsWith("createSchedule"))).toBe(true));
    const body = JSON.parse(f.calls.find((c) => c.startsWith("createSchedule"))!.slice("createSchedule ".length));
    expect(body).toMatchObject({ name: "Check the deploy", prompt: "Check the deploy", cron: "30 7 * * 1-5", mode: "fresh" });
    expect(typeof body.timezone).toBe("string");
    await waitFor(() => expect(screen.queryByTestId("automation-create")).toBeNull());
    expect(screen.getByTestId("automation-sheet")).toBeDefined();
  });

  test("an invalid sheet shows the fix and does not call the server; a server refusal stays on the sheet", async () => {
    const f = fake();
    mount();
    fireEvent.click(screen.getByText("open-create"));
    const sheet = await screen.findByTestId("automation-create");
    fireEvent.change(within(sheet).getByLabelText("What"), { target: { value: "" } });
    fireEvent.click(within(sheet).getByTestId("automation-save"));
    expect((await within(sheet).findAllByRole("alert")).map((a) => a.textContent).join()).toContain("Say what to run");
    expect(f.calls).toEqual([]);
    fireEvent.change(within(sheet).getByLabelText("What"), { target: { value: "x" } });
    Object.assign(automationApi, { createSchedule: async () => ({ kind: "error", status: 409, body: { error: "50 chat schedules are already active (limit 50)" } }) });
    fireEvent.click(within(sheet).getByTestId("automation-save"));
    expect((await within(sheet).findByTestId("automation-problem")).textContent).toContain("limit 50");
  });

  test("editing a schedule opens its values and saves a change", async () => {
    const f = fake({ schedules: [sched()] });
    mount();
    fireEvent.click(screen.getByTestId("automation-btn"));
    fireEvent.click(await screen.findByText("Edit"));
    const sheet = await screen.findByTestId("automation-create");
    expect((within(sheet).getByLabelText("Name") as HTMLInputElement).value).toBe("Morning news");
    expect(within(sheet).getByRole("button", { name: "Weekdays at 09:00" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "News" } });
    fireEvent.click(within(sheet).getByTestId("automation-save"));
    await waitFor(() => expect(f.calls.some((c) => c.startsWith("editSchedule sch-1"))).toBe(true));
    expect(f.calls.find((c) => c.startsWith("editSchedule"))).toContain('"name":"News"');
  });

  test("loop sheet: every N minutes, max, a stop condition and the mode go to the server", async () => {
    const f = fake();
    mount();
    fireEvent.click(screen.getByTestId("automation-btn"));
    fireEvent.click(await screen.findByRole("tab", { name: /Loops/ }));
    fireEvent.click(screen.getByTestId("automation-new"));
    const sheet = await screen.findByTestId("automation-create");
    fireEvent.change(within(sheet).getByLabelText("Prompt"), { target: { value: "Check the build" } });
    fireEvent.change(within(sheet).getByLabelText("Minutes"), { target: { value: "15" } });
    fireEvent.change(within(sheet).getByLabelText("Max iterations"), { target: { value: "5" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "When this is true" }));
    fireEvent.change(within(sheet).getByLabelText("Stop condition"), { target: { value: "the build is green" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Fresh session" }));
    fireEvent.click(within(sheet).getByTestId("automation-save"));
    await waitFor(() => expect(f.calls.some((c) => c.startsWith("createLoop"))).toBe(true));
    expect(JSON.parse(f.calls[0]!.slice("createLoop ".length))).toEqual({ label: "Check the build", prompt: "Check the build", every: 900, mode: "fresh", max: 5, until_text: "the build is green" });
  });

  test("monitor sheet: type selector, condition, interval, once, expiry and then", async () => {
    const f = fake();
    mount();
    fireEvent.click(screen.getByTestId("automation-btn"));
    fireEvent.click(await screen.findByRole("tab", { name: /Monitors/ }));
    fireEvent.click(screen.getByTestId("automation-new"));
    const sheet = await screen.findByTestId("automation-create");
    fireEvent.click(within(sheet).getByRole("button", { name: "URL" }));
    fireEvent.change(within(sheet).getByLabelText("Target"), { target: { value: "https://example.com/health" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Text changes" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Once" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Ask the agent to act" }));
    fireEvent.change(within(sheet).getByLabelText("What the agent should do"), { target: { value: "Summarise what changed" } });
    fireEvent.change(within(sheet).getByLabelText("Ends after"), { target: { value: "6h" } });
    fireEvent.click(within(sheet).getByTestId("automation-save"));
    await waitFor(() => expect(f.calls.some((c) => c.startsWith("createMonitor"))).toBe(true));
    expect(JSON.parse(f.calls[0]!.slice("createMonitor ".length))).toMatchObject({
      spec: { type: "url", target: "https://example.com/health", condition: "text" }, every: 60, once: true, expires_in: 21600, then: { mode: "act", prompt: "Summarise what changed" },
    });
  });

  test("a blocked URL is refused on the sheet", async () => {
    const f = fake();
    mount();
    fireEvent.click(screen.getByTestId("automation-btn"));
    fireEvent.click(await screen.findByRole("tab", { name: /Monitors/ }));
    fireEvent.click(screen.getByTestId("automation-new"));
    const sheet = await screen.findByTestId("automation-create");
    fireEvent.click(within(sheet).getByRole("button", { name: "URL" }));
    fireEvent.change(within(sheet).getByLabelText("Target"), { target: { value: "http://169.254.169.254/latest/meta-data" } });
    fireEvent.click(within(sheet).getByTestId("automation-save"));
    expect((await within(sheet).findAllByRole("alert")).map((a) => a.textContent).join()).toContain("blocked");
    expect(f.calls).toEqual([]);
  });
});

describe("slash commands through the host", () => {
  test("ordinary text is left alone", async () => {
    fake();
    mount();
    expect(await slash("hello there")).toBe("undefined");
  });

  test("/schedule saves a schedule in this chat; the toast names it", async () => {
    const f = fake();
    mount();
    expect(await slash("/schedule every day at 09:00 summarise the news")).toBe("null");
    expect(JSON.parse(f.calls[0]!.slice("createSchedule ".length))).toMatchObject({ cron: "0 9 * * *", prompt: "summarise the news", mode: "message" });
    expect((await screen.findByText(/Scheduled: summarise the news/)).textContent).toBeDefined();
  });

  test("/loop and /watch start a loop and a monitor; a bad line returns the problem and the text stays", async () => {
    const f = fake();
    mount();
    expect(await slash("/loop 10m check the build")).toBe("null");
    expect(JSON.parse(f.calls[0]!.slice("createLoop ".length))).toMatchObject({ every: 600, prompt: "check the build", max: 20 });
    expect(await slash("/watch https://example.com")).toBe("null");
    expect(JSON.parse(f.calls[1]!.slice("createMonitor ".length))).toMatchObject({ spec: { type: "url", target: "https://example.com" }, every: 60 });
    expect(await slash("/schedule nonsense")).toMatch(/Say when first/);
    expect(await slash("/loop 3s x")).toMatch(/at least 10s/);
    expect(f.calls).toHaveLength(2);
  });

  test("/schedules, /loops and /monitors open the sheet on that tab", async () => {
    fake();
    mount();
    expect(await slash("/loops")).toBe("null");
    expect((await screen.findByRole("tab", { name: /Loops/ })).getAttribute("aria-selected")).toBe("true");
    expect(await slash("/monitors")).toBe("null");
    await waitFor(() => expect(screen.getByRole("tab", { name: /Monitors/ }).getAttribute("aria-selected")).toBe("true"));
  });

  test("a server refusal comes back as the problem", async () => {
    fake();
    Object.assign(automationApi, { createSchedule: async () => ({ kind: "error", status: 400, body: { error: "a chat schedule must be at least 5 minutes apart" } }) });
    mount();
    expect(await slash("/schedule every 1 minutes poll")).toMatch(/5 minutes/);
  });
});

const row = (over: Partial<Message>): Message => ({ id: "msg-1", chat_id: "chat-1", role: "assistant", content: "", status: "done", error: null, model_used: null, input_tokens: 0, output_tokens: 0, cost_usd: null, started_at: null, finished_at: null, created_at: new Date().toISOString(), attachments: [], ...over });

describe("messages and composer", () => {
  test("a scheduled user message shows a quiet marker without the Scheduled: line; Schedule this opens the sheet with the prompt", async () => {
    fake();
    mount(<MessageView message={row({ role: "user", content: "Scheduled: Morning news\n\nSummarise the news" })} now={0} onOpenImage={() => {}} />);
    expect(screen.getByTestId("msg-scheduled").textContent).toContain("Morning news");
    expect(document.body.textContent).not.toContain("Scheduled: Morning news\n");
    fireEvent.click(screen.getByTestId("msg-schedule-this"));
    const sheet = await screen.findByTestId("automation-create");
    expect((within(sheet).getByLabelText("What") as HTMLTextAreaElement).value).toBe("Summarise the news");
  });

  test("a result block shows its title, counter and link; an error block uses the error style", async () => {
    const parts = (level: string) => [{ type: "text", text: "x" }, { type: "automation", kind: "schedule", level, title: "Scheduled result: Morning news", counter: "iteration 3 of 5", link: "#/schedules" }];
    const { rerender } = render(<MessageView message={row({ content: "Here is the summary", parts: parts("result") as never })} now={0} onOpenImage={() => {}} />);
    const block = await screen.findByTestId("automation-block");
    expect(block.textContent).toContain("Scheduled result: Morning news");
    expect(block.textContent).toContain("iteration 3 of 5");
    expect(block.querySelector("a")?.getAttribute("href")).toBe("/#/schedules");
    expect(block.className).not.toContain("is-error");
    rerender(<MessageView message={row({ status: "error", content: "The run failed: boom", parts: parts("error") as never })} now={0} onOpenImage={() => {}} />);
    expect((await screen.findByTestId("automation-block")).className).toContain("is-error");
  });

  test("the composer clock button hands the typed text to the sheet; without a handler it is absent", () => {
    const seen: string[] = [];
    const props = { chatId: "chat-1", blocked: null, running: false, onSend: async () => null, onStop: () => {}, onOpenImage: () => {}, storage: window.sessionStorage };
    const { rerender } = render(<Composer {...props} onSchedule={(t) => { seen.push(t); }} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "  check disk space " } });
    fireEvent.click(screen.getByTestId("composer-clock"));
    expect(seen).toEqual(["check disk space"]);
    rerender(<Composer {...props} />);
    expect(screen.queryByTestId("composer-clock")).toBeNull();
  });
});

describe("chat list", () => {
  test("a chat with a new automation result shows the unread dot; a read one does not", () => {
    const chat = (unread: number) => ({ id: "chat-1", project_id: null, title: "Daily", harness: "claude", profile: "main", model_id: null, session_id: null, status: "idle", created_at: "a", updated_at: "b", archived_at: null, cwd: null, effective_cwd: null, unread }) as never;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (u: number) => (
      <QueryClientProvider client={client}><ToastProvider><ChatListRow chat={chat(u)} href="#/chats/chat-1" /></ToastProvider></QueryClientProvider>
    );
    const { rerender } = render(view(1));
    expect(screen.getByTestId("thread-unread").getAttribute("aria-label")).toContain("new result");
    rerender(view(0));
    expect(screen.queryByTestId("thread-unread")).toBeNull();
  });
});
