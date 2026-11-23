import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, cleanup } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { resultLabel } = await import("../lib/node-flags");
const { NodeCard } = await import("./GraphSvg");
const { NodePanel } = await import("./NodePanel");
const { RunTable } = await import("./RunTable");
const { EMPTY_FILTER } = await import("./run-filter");
const { profilePalette } = await import("../lib/profile-color");

afterEach(cleanup);
afterAll(uninstall);

const TOKENS = { full: ["--status-full"], partial: ["--status-partial"], blocked: ["--status-blocked"] } as const;

function node(over: Partial<RunNode>): RunNode {
  return { id: "n1", label: "Node one", status: "done", profile: null, adapter: null, job_id: null, started: null, finished: null, error: null, log_tail: [], ...over } as RunNode;
}

function result(verdict: "full" | "partial" | "blocked" | "unknown") {
  return { verdict, summary: "the summary", follow_up: "none", at: "" };
}

function runOf(nodes: RunNode[]): RunState {
  return { run_id: "r1", title: "T", harness_session: "", started: null, finished: null, status: "running", nodes, edges: [] } as unknown as RunState;
}

function card(n: RunNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <svg>
        <NodeCard node={n} pos={{ x: 0, y: 0 }} selected={false} isCyclic={false} onSelect={() => {}} palette={profilePalette([])} harnessByProfile={{}} maxAttempts={5} runId="r1" waitingOn={[]} />
      </svg>
    </QueryClientProvider>,
  );
}

/** The declarations of every rule whose selector contains `selector`, joined. */
function rulesFor(files: string[], selector: string): string[] {
  const out: string[] = [];
  for (const file of files) {
    const css = readFileSync(join(import.meta.dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if ((m[1] ?? "").includes(selector)) out.push(m[2] ?? "");
    }
  }
  return out;
}

describe("result verdict colour and label", () => {
  test("resultLabel gives the accessible name for every verdict", () => {
    expect(resultLabel("partial")).toBe("Result: partial");
    expect(resultLabel("blocked")).toBe("Result: blocked");
  });

  test("table cell: full, partial and blocked each carry their verdict class, text and name", () => {
    const run = runOf([node({ id: "f", status: "done", result: result("full") }), node({ id: "p", status: "done", result: result("partial") }), node({ id: "b", status: "error", result: result("blocked") })]);
    const { container } = render(
      <ToastProvider>
        <RunTable run={run as never} filter={EMPTY_FILTER} harnessByProfile={{}} selectedId={null} onSelect={() => {}} />
      </ToastProvider>,
    );
    for (const verdict of ["full", "partial", "blocked"] as const) {
      const cell = screen.getByRole("img", { name: resultLabel(verdict) });
      expect(cell.textContent).toBe(verdict);
      expect(cell.className).toContain(`v-${verdict}`);
      expect(container.querySelector(`tr[data-verdict="${verdict}"]`)).not.toBeNull();
    }
  });

  test("graph card chip: text verdict and accessible name match the verdict", () => {
    const { container } = card(node({ status: "done", result: result("partial") }));
    const chip = container.querySelector(".result-chip");
    expect(chip?.classList.contains("result-partial")).toBe(true);
    expect(chip?.getAttribute("aria-label")).toBe("Result: partial");
    expect(chip?.querySelector("text")?.textContent).toBe("partial");
  });

  test("node panel status line shows the verdict next to the status, with a name", () => {
    for (const verdict of ["full", "partial", "blocked"] as const) {
      const { container, unmount } = render(
        <QueryClientProvider client={new QueryClient()}>
          <ToastProvider>
            <NodePanel run={runOf([node({ status: "done", result: result(verdict) })])} selectedId="n1" maxAttempts={5} flash={0} />
          </ToastProvider>
        </QueryClientProvider>,
      );
      const line = container.querySelector(".node-statusline");
      expect(line?.querySelector(".node-statusline-state")?.textContent).toBe("done");
      const verdictEl = line?.querySelector(`.node-statusline-result.result-${verdict}`);
      expect(verdictEl?.textContent).toBe(verdict);
      expect(verdictEl?.getAttribute("aria-label")).toBe(resultLabel(verdict));
      unmount();
    }
  });

  test("node without a result shows no verdict on the status line", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <NodePanel run={runOf([node({ status: "running" })])} selectedId="n1" maxAttempts={5} flash={0} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(container.querySelector(".node-statusline-result")).toBeNull();
  });

  test("CSS: full is done green, partial is stale amber, blocked is error red on every surface", () => {
    const files = ["../../snapshot/styles.css", "../../snapshot/run-table.css", "./runs.css"];
    for (const [verdict, tokens] of Object.entries(TOKENS)) {
      const surfaces = [`.result-chip.result-${verdict} text`, `.result-pill.result-${verdict}`, `.rt-verdict.v-${verdict}`, `.node-statusline-result.result-${verdict}`];
      for (const surface of surfaces) {
        const decls = rulesFor(files, surface).join(";");
        expect(decls.length).toBeGreaterThan(0);
        expect(tokens.some((token) => decls.includes(`var(${token})`))).toBe(true);
        expect(decls).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
      }
    }
    expect(rulesFor(files, ".result-chip.result-blocked text").join(";")).not.toContain("--status-stale");
  });
});
