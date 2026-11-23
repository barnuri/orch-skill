import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { api } = await import("../api/client");
const { RunParallel, parseParallel } = await import("./RunParallel");
const { readyText } = await import("./RunHealth");

mock.module("./run-actions", () => ({ refetchRun: async () => undefined }));

afterEach(() => {
  cleanup();
});
afterAll(uninstall);

const run = (max_parallel: number | null | undefined) => ({ run_id: "r1", status: "running", max_parallel }) as never;

function show(max: number | null | undefined) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <RunParallel run={run(max)} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const input = () => screen.getByLabelText("Run parallel cap") as HTMLInputElement;
const button = () => screen.getByRole("button", { name: "Set parallel" }) as HTMLButtonElement;

describe("parseParallel", () => {
  test("accepts -1 and integers 1-30", () => {
    expect(parseParallel("-1")).toBe(-1);
    expect(parseParallel("1")).toBe(1);
    expect(parseParallel(" 30 ")).toBe(30);
  });

  test("rejects 0, 31, -2, fractions, words and empty text", () => {
    for (const text of ["0", "31", "-2", "2.5", "many", ""]) {
      expect(parseParallel(text)).toBeNull();
    }
  });
});

describe("RunParallel", () => {
  test("shows the stored per-run cap", () => {
    show(7);
    expect(input().value).toBe("7");
  });

  test("an unset per-run cap shows an empty box with the global placeholder", () => {
    show(null);
    expect(input().value).toBe("");
    expect(input().placeholder).toBe("global");
    expect(button().disabled).toBe(true);
  });

  test("the button stays disabled until the value changes", () => {
    show(7);
    expect(button().disabled).toBe(true);
    fireEvent.change(input(), { target: { value: "8" } });
    expect(button().disabled).toBe(false);
  });

  test("an out-of-range value disables the button and marks the input invalid", () => {
    show(7);
    fireEvent.change(input(), { target: { value: "31" } });
    expect(button().disabled).toBe(true);
    expect(input().getAttribute("aria-invalid")).toBe("true");
  });

  test("applying -1 calls the API with -1", async () => {
    const spy = spyOn(api, "setRunMaxParallel").mockResolvedValue({ kind: "ok", data: { ok: true } } as never);
    show(7);
    fireEvent.change(input(), { target: { value: "-1" } });
    fireEvent.click(button());
    await waitFor(() => expect(spy).toHaveBeenCalledWith("r1", -1));
    spy.mockRestore();
  });

  test("applying 12 calls the API with 12", async () => {
    const spy = spyOn(api, "setRunMaxParallel").mockResolvedValue({ kind: "ok", data: { ok: true } } as never);
    show(7);
    fireEvent.change(input(), { target: { value: "12" } });
    fireEvent.click(button());
    await waitFor(() => expect(spy).toHaveBeenCalledWith("r1", 12));
    spy.mockRestore();
  });
});

describe("readyText with unlimited slots", () => {
  const health = (slots: number | null) =>
    ({ run: "r1", at: "", max_parallel: -1, running: 0, slots, nodes: [], ready: ["a"], changes: [] }) as never;

  test("slots null (unlimited) still announces the ready nodes", () => {
    expect(readyText(health(null))).not.toBeNull();
  });

  test("zero free slots announces nothing", () => {
    expect(readyText(health(0))).toBeNull();
  });
});
