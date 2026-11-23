// bun test preload: every test process starts without the identity of the session that runs it.
// Without this, a test that spawns dispatch.ts with { ...process.env } registers the caller's own terminal as the
// run's orchestrator (so a supervisor test never sees "no orchestrator"), or writes to the live ~/.harness-orch.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SESSION = /^(OPENCODE|CLAUDE|CLAUDECODE|HERDR|HC_|CODEX|COPILOT|CURSOR|ORCH_(SESSION|RESUME|RUN|NODE|JOB|EVENT|MODEL))/i;
for (const key of Object.keys(process.env)) {
  if (SESSION.test(key)) delete process.env[key];
}
for (const key of ["HARNESS_ORCH_HOME", "ORCH_DISPATCH", "LLM_HUB_URL", "LLM_HUB_V1_URL", "LLM_HUB_KEY"]) delete process.env[key];

process.env.ORCH_HERDR = "0";
process.env.ORCH_NO_ANNOUNCE = "1";
// A test that forgets to set its own home gets a private empty one, never the live state directory.
process.env.HARNESS_ORCH_HOME = mkdtempSync(join(tmpdir(), "orch-test-home-"));
