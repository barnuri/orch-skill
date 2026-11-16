import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RunMessage } from "../../shared/types/run-message";
import type { OrchPaths } from "../types/orch-paths";
import { isRunId } from "./run-id";

const MESSAGE_FILE = /^\d+\.json$/;

function readMessage(path: string): RunMessage | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as RunMessage;
    return typeof value.id === "string" && typeof value.seq === "number" ? value : null;
  } catch {
    return null;
  }
}

/** Every message of a run, oldest first. Unreadable files are skipped; a run without an inbox has none. */
export function readRunMessages(paths: OrchPaths, runId: string): RunMessage[] {
  if (!isRunId(runId)) {
    return [];
  }
  const root = join(paths.runs, runId, "inbox");
  if (!existsSync(root)) {
    return [];
  }
  const messages: RunMessage[] = [];
  for (const box of readdirSync(root, { withFileTypes: true })) {
    if (!box.isDirectory()) {
      continue;
    }
    for (const name of readdirSync(join(root, box.name))) {
      if (!MESSAGE_FILE.test(name)) {
        continue;
      }
      const message = readMessage(join(root, box.name, name));
      if (message !== null) {
        messages.push(message);
      }
    }
  }
  return messages.sort((a, b) => a.seq - b.seq);
}
