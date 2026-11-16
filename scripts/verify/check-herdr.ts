#!/usr/bin/env bun
// check-herdr.ts - orch herdr instance panes and tabs per workspace (read only). Never touches the user's own herdr.
import { join } from "node:path";
import { HOME } from "../lib/util.ts";

const H = process.env["ORCH_HERDR_HOME"] ?? join(HOME, ".harness-orch/herdr/home");
const env = { HERDR_SOCKET_PATH: undefined, HERDR_ENV: undefined, HERDR_PANE_ID: undefined, HOME: H };
const clean = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== undefined)) as Record<string, string>;
const herdr = (...a: string[]): any => {
  const p = Bun.spawnSync(["herdr", ...a], { env: clean, stdout: "pipe", stderr: "ignore" });
  if (p.exitCode !== 0) return null;
  try {
    return JSON.parse(p.stdout.toString());
  } catch {
    return null;
  }
};
const panesOut = herdr("pane", "list");
if (!panesOut) (console.log(`FAIL orch herdr instance not answering (${H})`), process.exit(1));
const panes: any[] = panesOut.result.panes;
console.log(`PASS orch herdr answers, ${panes.length} panes`);
for (const p of panes) console.log(`  ${p.pane_id} ${p.agent ?? "-"} ${p.agent_status} ${String(p.cwd).split("/").pop()}`);
const wss: any[] = herdr("workspace", "list")?.result?.workspaces ?? [];
console.log(`workspaces: ${wss.length}`);
for (const w of wss) {
  const tabs: any[] = herdr("tab", "list", "--workspace", w.workspace_id)?.result?.tabs ?? [];
  console.log(`  workspace ${w.workspace_id} ${w.label}: ${tabs.length} tabs`);
  for (const t of tabs) {
    const np = panes.filter((p) => p.tab_id === t.tab_id).length;
    console.log(`    tab ${t.tab_id} ${t.label} panes=${np}`);
  }
}
