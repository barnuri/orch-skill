import { resolve } from "node:path";

const DEFAULT_DISPATCH: string = resolve(import.meta.dir, "../../skills/orch/scripts/dispatch.ts");

/** Absolute path of dispatch.ts; `ORCH_DISPATCH` overrides it (tests point it at a fake). Read per call. */
export function dispatchPath(): string {
  return process.env["ORCH_DISPATCH"] || DEFAULT_DISPATCH;
}
