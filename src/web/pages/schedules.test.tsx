import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Schedule } from "../../shared/types/schedule";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { ConfirmProvider } = await import("../components/ConfirmDialog");
const { queryClient, dropEtags, invalidateSchedules } = await import("../api/queries");
const { SchedulesPage } = await import("./SchedulesPage");

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

function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: "sch-20261115-100000-abcd",
    name: "nightly pull",
    cron: "0 9 * * *",
    kind: "command",
    enabled: true,
    created_at: "2026-11-15T10:00:00Z",
    prompt: null,
    profile: null,
    command: "git pull",
    workdir: null,
    timeout: 300,
    next_at: Math.floor(Date.now() / 1000) + 3600,
    last_run_at: null,
    last_status: null,
    runs: [],
    ...over,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** A fake API: GET /schedules answers the current list; PUT /schedules/{id} answers `onPut`. */
function serve(list: Schedule[], onPut: (body: Record<string, unknown>) => Response): Call[] {
  const calls: Call[] = [];
  let current = list;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (url.includes("/schedules/preview")) {
      return Promise.resolve(json(200, { next: "2026-11-16 14:30" }));
    }
    if (method === "PUT" && url.includes("/schedules/")) {
      const res = onPut(body as Record<string, unknown>);
      if (res.status === 200) {
        current = current.map((s) => ({ ...s, ...(body as Partial<Schedule>), timeout: 300 }));
      }
      return Promise.resolve(res);
    }
    if (url.endsWith("/schedules")) {
      return Promise.resolve(json(200, { generated_at: "2026-11-15T10:00:00Z", schedules: current }));
    }
    return Promise.resolve(json(404, { error: "no" }));
  }) as typeof fetch;
  return calls;
}

function page() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfirmProvider>
          <SchedulesPage />
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("schedule edit", () => {
  test("Edit opens the form prefilled, Save sends the change, toasts and refreshes the list", async () => {
    const calls = serve([schedule()], () => json(200, { ok: true }));
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Edit nightly pull" }));
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("nightly pull");
    expect((screen.getByLabelText("Cron expression") as HTMLInputElement).value).toBe("0 9 * * *");
    expect((screen.getByLabelText("Command") as HTMLTextAreaElement).value).toBe("git pull");
    expect((screen.getByLabelText("Time limit (optional)") as HTMLInputElement).value).toBe("5m");
    await screen.findByText("Next run: 2026-11-16 14:30");
    fireEvent.change(name, { target: { value: "renamed" } });
    fireEvent.change(screen.getByLabelText("Cron expression"), { target: { value: "30 14 * * *" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved renamed");
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toEndWith("/schedules/sch-20261115-100000-abcd");
    expect(put?.body).toEqual({ name: "renamed", cron: "30 14 * * *", kind: "command", command: "git pull", workdir: "", timeout: "5m" });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    });
    expect(await screen.findByRole("heading", { name: "renamed" })).toBeTruthy();
  });

  test("a server error is shown inline and the form stays open", async () => {
    serve([schedule()], () => json(400, { error: "schedule edit: bad or never-matching cron: 61 * * * *" }));
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Edit nightly pull" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("alert")).textContent).toContain("bad or never-matching cron");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
  });

  test("a list refresh while editing (a run became due and moved next_at) keeps focus and the typed values", async () => {
    const list = [schedule()];
    serve(list, () => json(200, { ok: true }));
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Edit nightly pull" }));
    const command = screen.getByLabelText("Command") as HTMLTextAreaElement;
    command.focus();
    fireEvent.change(command, { target: { value: "git pull --rebase" } });
    list[0] = schedule({ next_at: Math.floor(Date.now() / 1000) + 7200, last_run_at: "2026-11-15T11:00:00Z", last_status: "ok" });
    await invalidateSchedules();
    await waitFor(() => {
      expect(queryClient.getQueryData<{ schedules: Schedule[] }>(["schedules"])?.schedules[0]?.last_status).toBe("ok");
    });
    expect(document.activeElement).toBe(screen.getByLabelText("Command"));
    expect((screen.getByLabelText("Command") as HTMLTextAreaElement).value).toBe("git pull --rebase");
  });

  test("an empty required field is flagged before anything is sent, and Escape cancels", async () => {
    const calls = serve([schedule()], () => json(200, { ok: true }));
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Edit nightly pull" }));
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Enter a command.");
    expect(screen.getByLabelText("Command").getAttribute("aria-invalid")).toBe("true");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    });
  });
});

describe("cron meaning", () => {
  test("the list row and the form show the meaning, which follows the cron input as it is typed", async () => {
    serve([schedule()], () => json(200, { ok: true }));
    page();
    expect(await screen.findByText("At 09:00")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Edit nightly pull" }));
    const input = screen.getByLabelText("Cron expression");
    fireEvent.change(input, { target: { value: "*/15 * * * *" } });
    expect(screen.getByText("Every 15 minutes", { selector: ".sched-preview .sched-meaning" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "0 9 * * 1-5" } });
    expect(screen.getByText("At 09:00, Monday through Friday")).toBeTruthy();
    fireEvent.change(input, { target: { value: "61 * * * *" } });
    expect(screen.getByText("Invalid cron").className).toContain("is-bad");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByText("Invalid cron")).toBeNull();
  });
});

const CHAT_OPTIONS = {
  harnesses: [
    {
      id: "claude", label: "Claude Code", enabled: true, available: true, persistent: true, memory: "process",
      profiles: [
        {
          name: "claude-default", description: "", enabled: true, configured: true, problem: null,
          models: [
            { id: "claude-sonnet", label: "claude-sonnet", slug: "sonnet", description: "workhorse", default: true },
            { id: "claude-opus", label: "claude-opus", slug: "opus", description: "hardest", default: false },
          ],
        },
      ],
    },
  ],
  default_harness: "claude",
  default_profile: "claude-default",
};

/** `serve` plus GET /chat-options, the model picker's source. */
function serveWithOptions(list: Schedule[], onPut: (body: Record<string, unknown>) => Response): Call[] {
  const calls = serve(list, onPut);
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes("/chat-options") ? Promise.resolve(json(200, CHAT_OPTIONS)) : inner(input, init)) as typeof fetch;
  return calls;
}

const promptSchedule = (over: Partial<Schedule> = {}): Schedule =>
  schedule({ kind: "prompt", name: "morning", prompt: "summarise", profile: "claude-default", command: null, timeout: 0, ...over });

describe("schedule model", () => {
  test("the row and each run show the model, with a placeholder for the profile default", async () => {
    const run = { started_at: "2026-11-15T09:00:00Z", ended_at: "2026-11-15T09:01:00Z", kind: "prompt" as const, ref: "j1", status: "ok" as const, exit: null };
    serveWithOptions(
      [
        promptSchedule({ model: "claude-opus", runs: [{ ...run, model: "claude-opus" }, { ...run, started_at: "2026-11-14T09:00:00Z" }] }),
        promptSchedule({ id: "sch-20261115-100000-beef", name: "plain", model: null }),
      ],
      () => json(200, { ok: true }),
    );
    page();
    expect(await screen.findByText("model: claude-opus")).toBeTruthy();
    expect(screen.getByText("model: profile default")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Runs (2)" }));
    expect((await screen.findAllByTitle("Model this run used")).length).toBe(2);
    const runModels = screen.getAllByTitle("Model this run used").map((el) => el.textContent);
    expect(runModels).toEqual(["claude-opus", "profile default"]);
  });

  test("the model picker lists the profile default first, then the profile's models, and Save sends the pick", async () => {
    const calls = serveWithOptions([promptSchedule()], () => json(200, { ok: true }));
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Edit morning" }));
    const picker = await screen.findByTestId("schedule-model");
    await waitFor(() => {
      expect(picker.querySelectorAll('[role="option"]').length).toBe(3);
    });
    const labels = [...picker.querySelectorAll(".picker-opt-main")].map((el) => el.textContent);
    expect(labels).toEqual(["Profile default", "claude-sonnet", "claude-opus"]);
    expect(picker.querySelector("button")?.textContent).toContain("Profile default");
    fireEvent.click(picker.querySelector("button") as HTMLElement);
    fireEvent.click([...picker.querySelectorAll('[role="option"]')][2] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved morning");
    expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ kind: "prompt", profile: "claude-default", model: "claude-opus" });
  });

  test("going back to the profile default sends model null", async () => {
    const calls = serveWithOptions([promptSchedule({ model: "claude-opus" })], () => json(200, { ok: true }));
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Edit morning" }));
    const picker = await screen.findByTestId("schedule-model");
    await waitFor(() => {
      expect(picker.querySelector("button")?.textContent).toContain("claude-opus");
    });
    fireEvent.click(picker.querySelector("button") as HTMLElement);
    fireEvent.click(picker.querySelectorAll('[role="option"]')[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved morning");
    expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ model: null });
  });
});
