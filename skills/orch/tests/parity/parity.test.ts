import { test, expect } from "bun:test";
import { join } from "node:path";
import { readdirSync, readFileSync, existsSync, cpSync, writeFileSync } from "node:fs";
import { seedHome, tempDir, runCmd, ORCH_DIR, REPO_ROOT, autoCleanup } from "../helpers";
autoCleanup();

// The old parity suite ran every case on the bash path and on the Bun path and diffed them. With bash gone
// the two paths are one, so the cases now run on two fresh homes through the Bun CLI and must agree
// (stdout, stderr, exit code, normalized home tree). This keeps every case line as a regression check.
const DIR = import.meta.dir, BIN = join(ORCH_DIR, "bin/orch");
const split = (line: string) => line.match(/"([^"]*)"|'([^']*)'|\S+/g)!.map((w) => w.replace(/^["']|["']$/g, ""));
const tree = (home: string) => runCmd(["bun", join(DIR, "normalize.ts"), home]).out.split(home).join("<HOME>");
const norm = (s: string, home: string) => s.split(home).join("<HOME>");

for (const file of readdirSync(join(DIR, "cases")).filter((f) => f.endsWith(".cases"))) {
  test(`parity cases: ${file}`, () => {
    const text = readFileSync(join(DIR, "cases", file), "utf8");
    const fx = text.match(/^# fixture: (\S+) (\S+)/m);
    const env = { ORCH_OWNER_FILL: "0", ORCH_PARITY_FIXTURES: join(DIR, "fixtures") };
    let fxHome: string | undefined;
    if (fx) {
      fxHome = seedHome();
      const b = (...a: string[]) => runCmd(["bun", BIN, ...a], { home: fxHome, env });
      expect(b("run", "start", "fixture", "--id", fx[1]).rc).toBe(0);
      expect(b("node", "batch", fx[1], "--file", join(DIR, "fixtures", fx[2])).rc).toBe(0);
    }
    for (const line of text.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith(" "))) {
      const homes = [seedHome(), seedHome()];
      if (fxHome) for (const h of homes) cpSync(join(fxHome, "runs"), join(h, "runs"), { recursive: true });
      const res = homes.map((h) => runCmd(["bun", BIN, ...split(line)], { home: h, env }));
      expect([res[1].rc, norm(res[1].out, homes[1]), norm(res[1].err, homes[1]), tree(homes[1])], line)
        .toEqual([res[0].rc, norm(res[0].out, homes[0]), norm(res[0].err, homes[0]), tree(homes[0])]);
    }
  }, 120000);
}
