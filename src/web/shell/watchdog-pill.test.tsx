import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WatchdogAction, WatchdogFlag, WatchdogStatus } from "../../shared/types/watchdog";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, cleanup } = await import("@testing-library/react");
const { WatchdogPill, watchdogPillState } = await import("./WatchdogPill");

afterEach(cleanup);
afterAll(() => {
  cleanup();
  uninstall();
});

const RETRY: WatchdogAction = { at: "2026-11-16T10:00:00Z", run: "r1", node: "a", rule: "infra-retry", action: "node retry", detail: "exit=unknown", rc: 0 };

function status(patch: Partial<WatchdogStatus> = {}): WatchdogStatus {
  return { generated_at: "", state: "on", started_at: "", last_actions: [], runs: {}, flags: [], ...patch };
}

function flag(rule: WatchdogFlag["rule"]): WatchdogFlag {
  return { run: "r1", node: "a", rule, detail: "idle 20 min", at: "" };
}

describe("WatchdogPill", () => {
  test("state: off, ok, amber stalled, red out of retries", () => {
    expect(watchdogPillState(status({ state: "off" }))).toBe("off");
    expect(watchdogPillState(status())).toBe("ok");
    expect(watchdogPillState(status({ flags: [flag("stalled")] }))).toBe("stalled");
    expect(watchdogPillState(status({ flags: [flag("stalled"), flag("lost")] }))).toBe("error");
  });

  test("shows the state class and the last action", () => {
    const { container } = render(<WatchdogPill status={status({ last_actions: [RETRY], flags: [flag("stalled")] })} />);
    const pill = container.querySelector("#watchdog-pill");
    expect(pill?.className).toContain("is-stalled");
    expect(pill?.textContent).toContain("node retry r1/a");
    expect(pill?.getAttribute("title") ?? "").toContain("exit=unknown");
    expect(pill?.getAttribute("title") ?? "").toContain("r1/a stalled: idle 20 min");
  });

  test("off says off; hidden before the first answer", () => {
    expect(render(<WatchdogPill status={status({ state: "off" })} />).container.querySelector("#watchdog-pill")?.textContent).toContain("off");
    expect(render(<WatchdogPill status={null} />).container.querySelector("#watchdog-pill")).toBeNull();
  });

  test("the stylesheet colors each state from status tokens", () => {
    const css = readFileSync(join(import.meta.dir, "shell.css"), "utf8");
    expect(css).toContain(".watchdog-pill.is-ok { border-color: var(--okbd)");
    expect(css).toContain(".watchdog-pill.is-stalled { border-color: var(--status-stale-bd)");
    expect(css).toContain(".watchdog-pill.is-error { border-color: var(--erbd)");
  });
});
