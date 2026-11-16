import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HerdrHealth } from "../../shared/types/run-health";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, cleanup } = await import("@testing-library/react");
const { HerdrChip } = await import("./HerdrChip");

afterEach(cleanup);
afterAll(() => {
  cleanup();
  uninstall();
});

function health(state: HerdrHealth["state"], problems: string[] = []): HerdrHealth {
  return { state, enabled: state !== "off", reason: "", env_id: "orch-skill", pid: 1, pid_alive: true, socket_ok: state !== "down", registry: "ok", registry_path: "", web: "listed", web_url: "", nudged: false, at: "", problems };
}

describe("HerdrChip", () => {
  test("green ok, amber degraded, red down, each with its state class", () => {
    for (const state of ["ok", "degraded", "down"] as const) {
      const { container, unmount } = render(<HerdrChip health={health(state, state === "ok" ? [] : ["herdr web does not list orch-skill"])} />);
      const chip = container.querySelector("#herdr-chip");
      expect(chip?.className).toContain(`is-${state}`);
      expect(chip?.getAttribute("data-state")).toBe(state);
      expect(chip?.getAttribute("title") ?? "").toContain(state === "ok" ? "listed in herdr web" : "does not list");
      unmount();
    }
  });

  test("hidden when herdr is off or not checked yet", () => {
    expect(render(<HerdrChip health={health("off")} />).container.querySelector("#herdr-chip")).toBeNull();
    expect(render(<HerdrChip health={null} />).container.querySelector("#herdr-chip")).toBeNull();
    expect(render(<HerdrChip health={undefined} />).container.querySelector("#herdr-chip")).toBeNull();
  });

  test("the stylesheet colors each state", () => {
    const css = readFileSync(join(import.meta.dir, "shell.css"), "utf8");
    expect(css).toContain(".herdr-chip.is-ok { border-color: var(--okbd)");
    expect(css).toContain(".herdr-chip.is-degraded");
    expect(css).toContain(".herdr-chip.is-down { border-color: var(--erbd)");
  });
});
