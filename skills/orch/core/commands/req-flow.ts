// Requirement lifecycle beyond the ledger: independent verification and gap nodes.
//   implemented -> `req verify` creates a verifier node (never the implementer, never its profile) -> verifying
//   verifying   -> the verifier's `req verdict pass` closes it (done); `fail --gap "..."` reopens it and creates a gap node per gap
// `advanceRequirements` is the deterministic supervisor step: it moves every requirement as far as the facts allow.
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { loadRun, type RunState } from "../state/store.ts";
import { loadProfilesDoc } from "../state/settings.ts";
import { errLine, resolveRun } from "./node.ts";
import { independenceProblem, loadLedger, reqEvidence, reqLink, reqStatus, REQ_OK, type Req } from "./req.ts";

const BIN = join(import.meta.dir, "..", "..", "scripts", "dispatch.ts");
const safe = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 50);
export const verifierNodeId = (reqId: string): string => `verify-${safe(reqId)}`;

async function cli(home: string, args: string[]): Promise<{ rc: number; out: string }> {
  const p = Bun.spawn([process.execPath, BIN, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, HARNESS_ORCH_HOME: home } });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { rc: await p.exited, out: out + err };
}

/** A profile for the verifier: enabled, allowed for runs, and not any implementer's profile; another harness first. */
export async function pickVerifierProfile(home: string, run: RunState, r: Req, wanted = ""): Promise<string> {
  const used = new Set((r.implemented_by ?? []).map((id) => String((run.nodes as any[]).find((n) => n.id === id)?.profile ?? "")).filter(Boolean));
  if (wanted) return used.has(wanted) ? "" : wanted;
  const doc = (await loadProfilesDoc(home)) as any;
  const usedHarness = new Set([...used].map((p) => String(doc.profiles?.[p]?.harness ?? "")));
  const candidates = Object.entries<any>(doc.profiles ?? {})
    .filter(([name, p]) => p.enabled !== false && (p.usage ?? ["runs"]).includes("runs") && !used.has(name))
    .sort((a, b) => Number(usedHarness.has(a[1].harness)) - Number(usedHarness.has(b[1].harness)) || Number(b[1].priority ?? 0) - Number(a[1].priority ?? 0));
  return candidates[0]?.[0] ?? "";
}

function verifierPrompt(runId: string, r: Req, handoffs: string[], verifier: string): string {
  return [
    `You verify requirement ${r.id} of run ${runId}: "${r.text}".`,
    `You did not implement it and must not trust the implementer's own claims. Check it yourself.`,
    r.evidence.length ? `Evidence the implementers gave:\n${r.evidence.map((e) => `- ${e.note}${e.test ? ` (test: ${e.test})` : ""}${e.file ? ` (file: ${e.file})` : ""}`).join("\n")}` : "",
    handoffs.length ? `Implementer handoffs to read:\n${handoffs.map((h) => `- ${h}`).join("\n")}` : "",
    `Do: read the handoffs, inspect the changed code or UI, run the stated tests, and look for what is missing or only half done.`,
    `Then record your verdict:`,
    `- Everything is met: dispatch.ts req verdict ${runId} ${r.id} pass --node ${verifier} --note "<what you checked>"`,
    `- Something is missing: dispatch.ts req verdict ${runId} ${r.id} fail --node ${verifier} --gap "<missing piece 1>" --gap "<missing piece 2>"`,
    `Each gap becomes a new implementation node. Write handoff.md into $ORCH_NODE_OUT and record your node result with dispatch.ts node result (full only when you passed it).`,
  ].filter(Boolean).join("\n\n");
}

/** `req verify <run> <req> [--profile P]`: create the verifier node and move the requirement to verifying. */
export async function reqVerify(args: string[]): Promise<number> {
  const home = orchHome();
  const pos = args.filter((a) => !a.startsWith("--"));
  const pi = args.indexOf("--profile");
  const wanted = pi >= 0 ? (args[pi + 1] ?? "") : "";
  const runId = pos[0] ? await resolveRun(home, pos[0]) : null;
  const id = pos[1];
  if (!runId || !id) return (errLine("usage: dispatch.ts req verify <run-id> <req-id> [--profile P]"), 2);
  const run = await loadRun(home, runId);
  const r = (await loadLedger(home, runId)).requirements.find((x) => x.id === id);
  if (!run || !r) return (errLine(`req ${id}: not in run ${runId}`), 2);
  if (r.status !== "implemented") return (errLine(`req verify: ${id} is ${r.status}; only an implemented requirement is verified (dispatch.ts req status ${runId} ${id} implemented)`), 2);
  const profile = await pickVerifierProfile(home, run, r, wanted);
  if (!profile) return (errLine(`req verify: no profile differs from the implementers' ${(r.implemented_by ?? []).join(", ")}; pass --profile`), 2);
  const node = verifierNodeId(id);
  const handoffs = (r.implemented_by ?? []).map((n) => join(paths.runOutDir(home, runId, n), "handoff.md"));
  if (!(run.nodes as any[]).some((n) => n.id === node)) {
    const add = await cli(home, ["node", "add", runId, node, `Verify ${id}: ${r.text}`.slice(0, 120), "--profile", profile, "--role", "validation", "--acceptance", `requirement ${id} verified by someone other than its implementer`]);
    if (add.rc !== 0) return (errLine(`req verify: node add failed: ${add.out.trim()}`), 2);
  }
  const st = await reqStatus([runId, id, "verifying", "--verifier", node]);
  if (st !== 0) return st;
  const dispatch = await cli(home, ["node", "dispatch", runId, node, "--force", "--profile", profile, verifierPrompt(runId, r, handoffs, node)]);
  process.stdout.write(`${id} verifying by ${node} (${profile})${dispatch.rc === 0 ? "" : `; dispatch failed: ${dispatch.out.trim().split("\n").pop()}`}\n`);
  return 0;
}

/** Creates one implementation node per gap, links it to the requirement, and returns the node ids. */
export async function createRequirementGaps(home: string, runId: string, r: Req, gaps: string[]): Promise<string[]> {
  const run = await loadRun(home, runId);
  const existing = new Set((run?.nodes as any[] | undefined)?.map((n) => n.id) ?? []);
  const made: string[] = [];
  let n = 1;
  for (const gap of gaps) {
    let id = `gap-${safe(r.id)}-${n}`;
    while (existing.has(id)) id = `gap-${safe(r.id)}-${++n}`;
    existing.add(id);
    const add = await cli(home, ["node", "add", runId, id, `Fix gap in ${r.id}: ${gap}`.slice(0, 120), "--role", "implementation"]);
    if (add.rc !== 0) continue;
    await reqLink([runId, r.id, "--node", id]);
    const { AGENT_RULES_LINE } = await import("./gaps.ts");
    await cli(home, ["node", "dispatch", runId, id, "--force", `${AGENT_RULES_LINE}Requirement ${r.id} ("${r.text}") was checked by an independent verifier, who found this gap: ${gap}\nClose exactly this gap in this repository, prove it with a test or evidence, write handoff.md into $ORCH_NODE_OUT, then record a result. Do not verify your own work as final: a different node verifies ${r.id} again.`]);
    made.push(id);
  }
  return made;
}

/** `req verdict <run> <req> pass|fail --node <verifier> [--note T] [--gap T ...]`: only the requirement's verifier may call it. */
export async function reqVerdict(args: string[]): Promise<number> {
  const home = orchHome();
  const pos: string[] = [];
  const gaps: string[] = [];
  let node = "";
  let note = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--node") node = args[++i] ?? "";
    else if (a === "--note") note = args[++i] ?? "";
    else if (a === "--gap") gaps.push(args[++i] ?? "");
    else if (a.startsWith("--")) return (errLine(`req verdict: unknown argument ${a}`), 2);
    else pos.push(a);
  }
  const runId = pos[0] ? await resolveRun(home, pos[0]) : null;
  const [, id, verdict] = pos;
  if (!runId || !id || (verdict !== "pass" && verdict !== "fail") || !node) return (errLine('usage: dispatch.ts req verdict <run-id> <req-id> pass|fail --node <verifier> [--note T] [--gap "<missing>" ...]'), 2);
  const run = await loadRun(home, runId);
  const r = (await loadLedger(home, runId)).requirements.find((x) => x.id === id);
  if (!run || !r) return (errLine(`req ${id}: not in run ${runId}`), 2);
  if (r.status !== "verifying" || r.verifier !== node) return (errLine(`req verdict: ${id} is ${r.status}, verifier ${r.verifier ?? "none"}; only its verifier ${r.verifier ?? ""} may give a verdict while it is verifying`), 2);
  const why = independenceProblem(run, r, node);
  if (why) return (errLine(`req verdict: ${why}`), 2);
  const text = note || (verdict === "pass" ? "verified" : `gaps: ${gaps.join("; ") || "unspecified"}`);
  if ((await reqEvidence([runId, id, "--note", `verifier ${node} ${verdict}: ${text}`])) !== 0) return 2;
  if (verdict === "pass") {
    const rc = await reqStatus([runId, id, "done", "--force", "--reason", `independent verifier ${node} passed it`]);
    if (rc === 0) await markNotForced(home, runId, id);
    return rc;
  }
  const rc = await reqStatus([runId, id, "in_progress", "--reason", `verifier ${node} found gaps`]);
  if (rc !== 0) return rc;
  const made = await createRequirementGaps(home, runId, r, gaps.length ? gaps : [text]);
  process.stdout.write(`${id}: gap nodes ${made.join(", ") || "none created"}\n`);
  return 0;
}

// The verifier's own pass is the independent check, so the close is not a person's override.
async function markNotForced(home: string, runId: string, id: string): Promise<void> {
  const { acquireLock } = await import("../state/lock.ts");
  const { reqFile } = await import("./req.ts");
  const { writeJsonAtomic } = await import("../state/store.ts");
  const lock = await acquireLock(home, `req-${runId}`, 400, 50);
  if (!lock) return;
  try {
    const l = await loadLedger(home, runId);
    const r = l.requirements.find((x) => x.id === id);
    if (r) { r.forced = null; await writeJsonAtomic(reqFile(home, runId), l); }
  } finally {
    await lock.release();
  }
}

/** Supervisor step. Moves requirements along: finished work -> implemented -> verifier node -> done or gaps. Returns what it did. */
export async function advanceRequirements(home: string, runId: string): Promise<string[]> {
  const did: string[] = [];
  const run = await loadRun(home, runId);
  if (!run) return did;
  for (const r of (await loadLedger(home, runId)).requirements) {
    if (REQ_OK.includes(r.status)) continue;
    const linked = r.nodes.map((n) => (run.nodes as any[]).find((x) => x.id === n));
    if ((r.status === "open" || r.status === "in_progress") && linked.length > 0 && linked.every((n) => n && n.status === "done" && n.result?.verdict === "full")) {
      if ((await reqEvidence([runId, r.id, "--note", `nodes ${r.nodes.join(", ")} done with a full result`])) === 0 && (await reqStatus([runId, r.id, "implemented"])) === 0) did.push(`${r.id} implemented`);
    }
    const now = (await loadLedger(home, runId)).requirements.find((x) => x.id === r.id)!;
    if (now.status === "implemented") {
      if ((await reqVerify([runId, r.id])) === 0) did.push(`${r.id} verifying`);
    } else if (now.status === "verifying") {
      const v = (run.nodes as any[]).find((x) => x.id === now.verifier);
      if (!v || v.status === "error" || v.status === "skipped" || v.status === "stopped") {
        // A dead verifier is replaced: back to implemented, so the next pass creates a fresh one.
        await reqStatus([runId, r.id, "implemented"]);
        did.push(`${r.id} verifier lost`);
      } else if (v.status === "done" && v.result?.verdict === "full") {
        if ((await reqStatus([runId, r.id, "done"])) === 0) did.push(`${r.id} done`);
      } else if (v.status === "done") {
        const gaps = String(v.result?.follow_up ?? "").trim();
        await reqEvidence([runId, r.id, "--note", `verifier ${v.id} finished ${v.result?.verdict ?? "without a verdict"}: ${gaps || "no detail"}`]);
        await reqStatus([runId, r.id, "in_progress", "--reason", `verifier ${v.id} did not pass it`]);
        const made = await createRequirementGaps(home, runId, now, [gaps && gaps.toLowerCase() !== "none" ? gaps : `verifier ${v.id} did not pass ${r.id}: read ${join(paths.runOutDir(home, runId, v.id), "handoff.md")}`]);
        did.push(`${r.id} gaps ${made.join(",")}`);
      }
    }
  }
  return did;
}
