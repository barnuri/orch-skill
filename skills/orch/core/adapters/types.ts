// Contract between the node commands and the harness adapters. The commands call spawnNode(job) and
// know nothing else about a harness. The adapters port (take-adapters) supplies the real function with
// setSpawnNode(); until then spawn.ts bridges to `dispatch.ts start`.
export interface SpawnJob {
  home: string;
  runId: string;
  nodeId: string;
  target: { kind: "profile" | "adapter"; name: string };
  prompt: string;
  args: string[];
  env: Record<string, string>;
  /** Working directory of the job: the node's repo. */
  repo?: string;
  resumeSession?: string;
}

export interface SpawnResult {
  jobId: string;
}

export type SpawnNode = (job: SpawnJob) => Promise<SpawnResult>;
