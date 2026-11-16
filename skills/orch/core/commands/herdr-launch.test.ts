import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlainStream, runLaunch, stripAnsi } from "./herdr-launch";

function jobWith(argv: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-launch-"));
  writeFileSync(join(dir, "argv.json"), JSON.stringify(argv));
  return dir;
}

function fakeAgent(dir: string): string {
  const path = join(dir, "fake-agent.sh");
  writeFileSync(
    path,
    "#!/usr/bin/env bash\nprintf '\\033[31mred line\\033[0m\\n'\nprintf '\\033[1;32mbold green\\033[0m\\n'\nexit 3\n",
  );
  chmodSync(path, 0o755);
  return path;
}

describe("herdr-launch", () => {
  test("runs the agent under a pty: log keeps ANSI, log.plain has none, exit_code is 3", async () => {
    const job = jobWith([]);
    const agent = fakeAgent(job);
    writeFileSync(join(job, "argv.json"), JSON.stringify(["bash", agent]));
    const code = await runLaunch(job);
    expect(code).toBe(3);
    expect(readFileSync(join(job, "exit_code"), "utf8")).toBe("3");
    expect(existsSync(join(job, "ended_at"))).toBe(true);
    const log = readFileSync(join(job, "log"), "utf8");
    const plain = readFileSync(join(job, "log.plain"), "utf8");
    expect(log).toContain("\x1b[31m");
    expect(plain).not.toContain("\x1b");
    expect(plain).not.toContain("\r");
    expect(plain).toContain("red line");
    expect(plain).toContain("bold green");
  });

  test("the child sees a colour terminal", async () => {
    const job = jobWith(["bash", "-c", "printf '%s|%s' \"$FORCE_COLOR\" \"$COLORTERM\""]);
    await runLaunch(job);
    expect(readFileSync(join(job, "log.plain"), "utf8")).toContain("1|truecolor");
  });
});

describe("stripAnsi and PlainStream", () => {
  test("removes CSI, OSC and carriage returns", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m\r\n")).toBe("red\n");
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
  });

  test("an escape split across two chunks is removed whole", () => {
    const enc = new TextEncoder();
    const s = new PlainStream();
    const a = s.push(enc.encode("ok \x1b[3"));
    const b = s.push(enc.encode("1mred\x1b[0m"));
    expect(a + b + s.end()).toBe("ok red");
  });
});
