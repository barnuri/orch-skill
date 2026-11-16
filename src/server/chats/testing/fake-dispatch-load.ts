#!/usr/bin/env bun
// Like fake-dispatch.ts, but runs the real profile load (model validation from ORCH_MODEL_ID) and echoes
// the slug it resolved. Never calls a model.
import { loadProfile } from "../../../../skills/orch/core/adapters/spawn.ts";
import { orchHome } from "../../../../skills/orch/core/state/home.ts";

const a = process.argv.slice(2);
if (a[0] !== "run") {
  console.error(`unexpected: ${a.join(" ")}`);
  process.exit(2);
}
const r = await loadProfile(orchHome(), a[2] ?? "", { ...process.env } as Record<string, string>);
if (!r.ok) process.exit(r.rc);
process.stdout.write(`slug=${r.profile.model} id=${r.profile.modelId}`);
