// Worker thread that runs main() of skills/orch/core/cli.ts for the in-process test runner (see inproc.ts).
// It lives as long as the test file; each call replaces process.env and captures stdout, stderr and exits.
import { main } from "../../core/cli.ts";

declare const self: any;
class ExitSignal { constructor(readonly code: number) {} }

// ORCH_TEST_TRACE=<file>: log every process the in-process commands spawn.
if (process.env.ORCH_TEST_TRACE) {
  for (const k of ["spawn", "spawnSync"] as const) {
    const orig = (Bun as any)[k];
    (Bun as any)[k] = (...a: any[]) => { const t = performance.now(); const r = orig.apply(Bun, a); require("node:fs").appendFileSync(process.env.ORCH_TEST_TRACE!, `worker-${k}\t${(performance.now() - t).toFixed(0)}\t${JSON.stringify((a[0]?.cmd ?? a[0]) as any).slice(0, 120)}\n`); return r; };
  }
}
const text = (s: any) => (typeof s === "string" ? s : Buffer.from(s).toString());
const fmt = (a: any[]) => a.map((x) => (typeof x === "string" ? x : Bun.inspect(x))).join(" ") + "\n";

self.onmessage = async (e: any) => {
  const { sab, args, env, stdin, port } = e.data;
  let out = "", err = "", rc = 0;
  const ow = process.stdout.write, ew = process.stderr.write, ex = process.exit;
  const cons = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error };
  (process.stdout as any).write = (s: any) => ((out += text(s)), true);
  (process.stderr as any).write = (s: any) => ((err += text(s)), true);
  console.log = console.info = console.debug = (...a: any[]) => void (out += fmt(a));
  console.warn = console.error = (...a: any[]) => void (err += fmt(a));
  (process as any).exit = (c?: number) => { throw new ExitSignal(c ?? Number(process.exitCode ?? 0)); };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  process.exitCode = undefined;
  (globalThis as any).__orchStdin = stdin;
  try {
    const r = await main(args);
    rc = typeof r === "number" ? r : Number(process.exitCode ?? 0);
  } catch (x: any) {
    if (x instanceof ExitSignal) rc = x.code;
    else { err += String(x?.stack ?? x) + "\n"; rc = 1; }
  }
  process.exitCode = undefined;
  (globalThis as any).__orchStdin = undefined;
  process.stdout.write = ow; process.stderr.write = ew; (process as any).exit = ex;
  Object.assign(console, cons);
  port.postMessage({ out, err, rc });
  const ia = new Int32Array(sab);
  Atomics.store(ia, 0, 1);
  Atomics.notify(ia, 0);
};
