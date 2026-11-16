import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearScanCache, scanSignature, scanSuggestions } from "./scan-cache";

let home: string;
let fake: string;
let prev: string | undefined;

function runs(): number {
  return readFileSync(join(home, "count"), "utf8").length;
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "scan-cache-"));
  mkdirSync(join(home, "runs", "r1"), { recursive: true });
  writeFileSync(join(home, "runs", "r1", "state.json"), "{}");
  fake = join(home, "fake.ts");
  writeFileSync(fake, `#!/usr/bin/env bun\nawait Bun.sleep(200);\nrequire("node:fs").appendFileSync(process.env.HARNESS_ORCH_HOME + "/count", "x");\nprocess.stdout.write("scanned");\n`);
  chmodSync(fake, 0o755);
  writeFileSync(join(home, "count"), "");
  prev = process.env["ORCH_DISPATCH"];
  process.env["ORCH_DISPATCH"] = fake;
});

afterAll(() => {
  if (prev === undefined) delete process.env["ORCH_DISPATCH"];
  else process.env["ORCH_DISPATCH"] = prev;
});

describe("scanSuggestions", () => {
  test("shares one run, then serves from cache until inputs change", async () => {
    clearScanCache();
    const [a, b] = await Promise.all([scanSuggestions(home), scanSuggestions(home)]);
    expect(a.output).toBe("scanned");
    expect(b.output).toBe("scanned");
    expect(runs()).toBe(1);

    const t0 = performance.now();
    await scanSuggestions(home);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(runs()).toBe(1);

    const before = scanSignature(home);
    writeFileSync(join(home, "memory.json"), "[]");
    expect(scanSignature(home)).not.toBe(before);
    await scanSuggestions(home);
    expect(runs()).toBe(2);
  });
});
