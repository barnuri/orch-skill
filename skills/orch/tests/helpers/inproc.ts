// In-process orch runner: main() of core/cli.ts runs in a worker thread that lives as long as the test file.
// The test thread blocks on Atomics.wait while a call runs, so the API stays synchronous ({ rc, out, err, all }).
// Warm calls cost about 1 ms instead of a process start of 0.1 to 1 s.
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";

export interface InResult { rc: number; out: string; err: string; all: string }

let worker: Worker | undefined;
const sab = new SharedArrayBuffer(4);
const flag = new Int32Array(sab);
const WAIT_MS = Number(process.env.ORCH_TEST_CALL_MS ?? 120_000);

export function inProcess(args: string[], env: Record<string, string>, stdin?: string): InResult {
  worker ??= new Worker(new URL("./inproc-worker.ts", import.meta.url));
  const mc = new MessageChannel();
  Atomics.store(flag, 0, 0);
  worker.postMessage({ sab, args, env, stdin, port: mc.port2 }, [mc.port2 as any]);
  if (Atomics.wait(flag, 0, 0, WAIT_MS) === "timed-out") {
    stopInProcess();
    return { rc: 124, out: "", err: `orch ${args.join(" ")}: in-process call timed out after ${WAIT_MS} ms\n`, all: "" };
  }
  const m = receiveMessageOnPort(mc.port1)?.message as { out: string; err: string; rc: number } | undefined;
  mc.port1.close();
  if (!m) return { rc: 1, out: "", err: "in-process call returned no result\n", all: "" };
  return { rc: m.rc, out: m.out, err: m.err, all: m.out + m.err };
}

export function stopInProcess(): void {
  worker?.terminate();
  worker = undefined;
}
