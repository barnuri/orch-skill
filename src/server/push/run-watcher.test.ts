import { describe, expect, test } from "bun:test";

import { TempHome } from "../test-support/temp-home";
import { RunWatcher } from "./run-watcher";
import type { NotifyInput } from "./hub";
import type { PushCategory } from "../../shared/push";

const RUN = "20261123-100000-aaaa";

function writeRun(home: TempHome, nodeStatus: string): void {
  home.write(`runs/${RUN}/state.json`, JSON.stringify({
    run_id: RUN,
    title: "t",
    status: "running",
    started: "2026-11-23T10:00:00.000Z",
    nodes: [{ id: "n1", label: "build", status: nodeStatus }],
  }));
}

describe("RunWatcher", () => {
  test("announces a node finish once, and skips a run whose state.json did not change", () => {
    const home = TempHome.create();
    try {
      writeRun(home, "running");
      const sent: Array<[PushCategory, NotifyInput]> = [];
      const watcher = new RunWatcher(home.path, (category, input) => {
        sent.push([category, input]);
        return undefined;
      });
      watcher.scan();
      expect(sent).toHaveLength(0);
      writeRun(home, "done");
      watcher.scan();
      expect(sent.map(([c, i]) => [c, i.body])).toEqual([["runs", "Task finished: build"]]);
      watcher.scan();
      expect(sent).toHaveLength(1);
    } finally {
      home.dispose();
    }
  });
});
