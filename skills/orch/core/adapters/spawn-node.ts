// spawnNode: starts one detached job for a node. Default is a bridge to `dispatch.ts start`;
// the adapters port replaces it through setSpawnNode.
import { join } from "node:path";
import type { SpawnJob, SpawnNode, SpawnResult } from "./types.ts";

const bridge: SpawnNode = async (job: SpawnJob): Promise<SpawnResult> => {
  const dispatch = process.env.ORCH_DISPATCH || join(import.meta.dir, "../../scripts/dispatch.ts");
  const argv = [process.execPath, dispatch, "start"];
  if (job.target.kind === "profile") argv.push("--profile", job.target.name);
  else argv.push(job.target.name);
  argv.push(job.prompt, ...job.args);
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...job.env, HARNESS_ORCH_HOME: job.home };
  if (job.resumeSession) env.ORCH_RESUME_SESSION = job.resumeSession;
  const p = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) {
    process.stderr.write(err);
    throw Object.assign(new Error(`start failed (${code})`), { code });
  }
  return { jobId: out.trim().split("\n").pop() ?? "" };
};

let impl: SpawnNode = bridge;

export function setSpawnNode(fn: SpawnNode): void {
  impl = fn;
}

export function spawnNode(job: SpawnJob): Promise<SpawnResult> {
  return impl(job);
}
