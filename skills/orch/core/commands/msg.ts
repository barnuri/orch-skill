// `msg send` and `msg read`: the per-run mailbox runs/<id>/messages.jsonl. Ported from lib/runs/plan.sh.
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { nowIso } from "../state/clock.ts";
import { orchHome } from "../state/home.ts";
import { loadRun } from "../state/store.ts";
import { findNode } from "../runs/node.ts";
import { errLine, resolveRun } from "./node.ts";

export const MSG_SEND_USAGE = 'dispatch.sh msg send <run-id> --to orch|all|<node-id> [--from <node-id>|orch] "<text>"';
export const MSG_READ_USAGE = "dispatch.sh msg read <run-id> [--for orch|<node-id>] [--since N] [--all]";
const MSG_MAX_BYTES = 4000;

const messagesFile = (home: string, run: string) => join(home, "runs", run, "messages.jsonl");

async function herdrNotify(run: string, from: string, to: string, text: string): Promise<void> {
  if (process.env.HERDR_ENV !== "1" || !Bun.which("herdr")) return;
  try {
    const p = Bun.spawn(["herdr", "notification", "show", `orch ${run}: ${from} → ${to}`, "--body", text, "--sound", "request"], { stdout: "ignore", stderr: "ignore" });
    await p.exited;
  } catch {
    /* best effort */
  }
}

export async function msgSend(args: string[]): Promise<number> {
  const runArg = args[0] ?? "";
  if (!runArg) return (errLine(`usage: ${MSG_SEND_USAGE}`), 2);
  let to = "";
  let from = "";
  let text = "";
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--to") to = rest[++i] ?? "";
    else if (a === "--from") from = rest[++i] ?? "";
    else if (a.startsWith("-")) return (errLine(`msg send: unknown argument ${a}\n  usage: ${MSG_SEND_USAGE}`), 2);
    else if (!text) text = a;
  }
  if (!to || !text) return (errLine(`usage: ${MSG_SEND_USAGE}`), 2);
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  const run = await loadRun(home, runId);
  if (!run) return (errLine(`run ${runId}: unknown run`), 2);
  if (!from) from = process.env.ORCH_RUN_ID === runId && process.env.ORCH_NODE_ID ? process.env.ORCH_NODE_ID : "orch";
  for (const id of [to, from]) {
    if (id === "orch" || id === "all") continue;
    if (!findNode(run, id)) return (errLine(`node ${id}: not in this run`), 2);
  }
  if (from === "all") return (errLine("msg send: --from cannot be all"), 2);
  if ([...text].length > MSG_MAX_BYTES) return (errLine(`msg send: text is over ${MSG_MAX_BYTES} characters — write it to a file and send the path`), 2);
  await appendFile(messagesFile(home, runId), JSON.stringify({ ts: nowIso(), from, to, text }) + "\n");
  await herdrNotify(runId, from, to, text);
  process.stdout.write("sent\n");
  return 0;
}

export async function msgRead(args: string[]): Promise<number> {
  const runArg = args[0] ?? "";
  if (!runArg) return (errLine(`usage: ${MSG_READ_USAGE}`), 2);
  let forId = "";
  let since = "0";
  let all = false;
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--for") forId = rest[++i] ?? "";
    else if (a === "--since") since = rest[++i] ?? "";
    else if (a === "--all") all = true;
    else return (errLine(`msg read: unknown argument ${a}\n  usage: ${MSG_READ_USAGE}`), 2);
  }
  if (!/^[0-9]+$/.test(since)) return (errLine("msg read: --since expects a line number"), 2);
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  if (!(await loadRun(home, runId))) return (errLine(`run ${runId}: unknown run`), 2);
  if (!forId) forId = process.env.ORCH_RUN_ID === runId && process.env.ORCH_NODE_ID ? process.env.ORCH_NODE_ID : "orch";
  const f = Bun.file(messagesFile(home, runId));
  if (!(await f.exists())) return 0;
  const lines = (await f.text()).split("\n").filter((l) => l.trim() !== "");
  let out = "";
  lines.forEach((l, idx) => {
    const n = idx + 1;
    const m = JSON.parse(l);
    if (n <= Number(since)) return;
    if (!(all || ((m.to === forId || m.to === "all") && m.from !== forId))) return;
    out += `${n}\t${m.ts}\t${m.from} -> ${m.to}\t${m.text}\n`;
  });
  process.stdout.write(out);
  return 0;
}
