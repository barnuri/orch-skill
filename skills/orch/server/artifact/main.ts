import { mkdirSync } from "node:fs";

import { orchPaths } from "../files/paths";
import type { ServerContext } from "../types/server-context";
import { ArtifactEmitter } from "./artifact-emitter";
import { IslandBuilder } from "./island-builder";

export const ARTIFACT_USAGE: string =
  "artifact/main.ts --home DIR --run RUN_ID --out DIR [--harnesses a,b] [--outcomes a,b]";
export const EXIT_OK: number = 0;
export const EXIT_FAIL: number = 1;
export const EXIT_USAGE: number = 2;

interface ArtifactArgs {
  home: string;
  runId: string;
  outDir: string;
  harnesses: readonly string[];
  outcomes: readonly string[];
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export function parseArtifactArgs(argv: readonly string[]): ArtifactArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined) {
      throw new Error(`artifact: unexpected argument ${flag ?? ""}`.trim());
    }
    values.set(flag.slice(2), value);
  }
  const home = values.get("home");
  const runId = values.get("run");
  const outDir = values.get("out");
  if (home === undefined || runId === undefined || outDir === undefined) {
    throw new Error("artifact: --home, --run and --out are all required");
  }
  return {
    home,
    runId,
    outDir,
    harnesses: splitList(values.get("harnesses") ?? ""),
    outcomes: splitList(values.get("outcomes") ?? ""),
  };
}

// Only the read handlers run here, and none of them consults the token — the digest is present
// to satisfy the shared context type, never to authorise anything.
function contextOf(args: ArtifactArgs): ServerContext {
  return {
    paths: orchPaths(args.home),
    bindHost: "127.0.0.1",
    hostname: "artifact",
    tokenDigest: new Uint8Array(),
    requireToken: false,
    requireRemoteToken: false,
    harnesses: args.harnesses,
    outcomes: args.outcomes,
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: ArtifactArgs;
  try {
    args = parseArtifactArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(`usage: ${ARTIFACT_USAGE}\n`);
    return EXIT_USAGE;
  }

  const ctx = contextOf(args);
  const built = await new IslandBuilder(ctx).forRun(args.runId);
  if (built.kind === "missing-run") {
    process.stderr.write(`artifact: no run ${built.runId} under ${ctx.paths.runs}\n`);
    return EXIT_FAIL;
  }

  mkdirSync(args.outDir, { recursive: true });
  const emitted = await new ArtifactEmitter().emit(args.outDir, built.islands);
  if (emitted.kind === "bundle-failed") {
    process.stderr.write(`artifact: bundling the dashboard failed: ${emitted.message}\n`);
    return EXIT_FAIL;
  }
  if (emitted.kind === "no-head") {
    process.stderr.write("artifact: the bundled index.html has no </head> to splice into\n");
    return EXIT_FAIL;
  }

  process.stdout.write(`${emitted.indexPath}\n`);
  process.stderr.write(
    `artifact: ${emitted.islandNames.length} embedded document(s): ${emitted.islandNames.join(", ")}\n`,
  );
  return EXIT_OK;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
