import { expect, test } from "bun:test";
import { clearRemoteWatchdogStatus, remoteWatchdogStatus, setRemoteWatchdogStatus } from "./bridge";
import type { WatchdogStatus } from "../../shared/types/watchdog";

const status = { state: "on" } as unknown as WatchdogStatus;

test("the worker snapshot is served until it is cleared", () => {
  expect(remoteWatchdogStatus("/h")).toBeNull();
  setRemoteWatchdogStatus("/h", status);
  expect(remoteWatchdogStatus("/h")).toBe(status);
  clearRemoteWatchdogStatus("/h");
  expect(remoteWatchdogStatus("/h")).toBeNull();
});
