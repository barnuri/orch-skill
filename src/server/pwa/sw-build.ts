import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WEB = resolve(import.meta.dir, "../../web/pwa");
const SOURCES = [resolve(WEB, "sw.ts"), resolve(WEB, "sw-strategy.ts"), resolve(import.meta.dir, "../../shared/push.ts")];

let built: Promise<{ code: string; version: string }> | null = null;

/** Bundles src/web/pwa/sw.ts once per process. The version is a hash of the worker's sources, so a changed worker rolls the caches. */
export function serviceWorkerSource(): Promise<{ code: string; version: string }> {
  built ??= (async () => {
    const hash = createHash("sha256");
    for (const f of SOURCES) hash.update(readFileSync(f));
    const version = hash.digest("hex").slice(0, 10);
    const out = await Bun.build({ entrypoints: [SOURCES[0] as string], target: "browser", minify: true, define: { __SW_VERSION__: JSON.stringify(version) } });
    if (!out.success || out.outputs[0] === undefined) throw new Error(`service worker build failed: ${out.logs.map(String).join("; ")}`);
    return { code: await out.outputs[0].text(), version };
  })();
  built.catch(() => {
    built = null;
  });
  return built;
}
