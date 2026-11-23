// herdr-launch: runs one job's argv under a pty. Started by the herdr pane as
//   bun <path>/herdr-launch.ts <job-dir>
// Reads <job-dir>/argv.json (a JSON array: the command and its arguments). Writes the pty output
// to <job-dir>/log (ANSI kept, for the pane and the dashboard) and <job-dir>/log.plain (ANSI and
// carriage returns removed, for greps, the watchdog and the health reader). Writes exit_code and
// ended_at when the child ends. SIGTERM, SIGINT and SIGHUP go to the child.

import { closeSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

// CSI, OSC and two-byte escapes.
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// An escape cut by the end of a read. It waits for the next read.
const INCOMPLETE_TAIL = /\x1b(?:\[[0-?]*[ -/]*)?$|\x1b\][^\x07\x1b]*$/;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(/\r/g, "");
}

// Strips ANSI from a byte stream read in chunks. An escape split across two chunks is held back.
export class PlainStream {
  private carry = "";
  private decoder = new TextDecoder();

  push(chunk: Uint8Array): string {
    const text = this.carry + this.decoder.decode(chunk, { stream: true });
    const tail = text.match(INCOMPLETE_TAIL);
    const cut = tail ? text.length - tail[0].length : text.length;
    this.carry = tail ? tail[0] : "";
    return stripAnsi(text.slice(0, cut));
  }

  end(): string {
    const rest = this.carry + this.decoder.decode();
    this.carry = "";
    return stripAnsi(rest);
  }
}

function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function writeAll(fd: number, data: Uint8Array | string): void {
  try {
    writeSync(fd, data);
  } catch {
    // The pane may be gone. The log file still gets the output.
  }
}

// Runs the job and returns its exit code.
export async function runLaunch(jobDir: string): Promise<number> {
  const argv = JSON.parse(readFileSync(join(jobDir, "argv.json"), "utf8")) as string[];
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("argv.json must be a non-empty array");
  const logFd = openSync(join(jobDir, "log"), "a");
  const plainFd = openSync(join(jobDir, "log.plain"), "a");
  const plain = new PlainStream();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FORCE_COLOR: "1",
    COLORTERM: "truecolor",
    TERM: process.env.TERM && process.env.TERM !== "dumb" ? process.env.TERM : "xterm-256color",
  };

  const proc = Bun.spawn({
    cmd: argv,
    env,
    stdin: "ignore",
    terminal: {
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 40,
      data(_terminal, data) {
        writeAll(logFd, data);
        writeAll(1, data);
        const text = plain.push(data);
        if (text) writeAll(plainFd, text);
      },
    },
  });

  const forward = (signal: NodeJS.Signals) => () => {
    try {
      proc.kill(signal);
    } catch {
      // The child already ended.
    }
  };
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGHUP", forward("SIGHUP"));

  const code = (await proc.exited) ?? 1;
  proc.terminal?.close();
  const rest = plain.end();
  if (rest) writeAll(plainFd, rest);
  closeSync(logFd);
  closeSync(plainFd);
  writeFileAtomic(join(jobDir, "exit_code"), String(code));
  writeFileSync(join(jobDir, "ended_at"), `${new Date().toISOString()}\n`);
  Bun.spawn(["bun", join(dirname(import.meta.dir), "cli.ts"), "herdr", "close-ended", jobDir], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return code;
}

if (import.meta.main) {
  const jobDir = process.argv[2];
  if (!jobDir) {
    process.stderr.write("usage: herdr-launch.ts <job-dir>\n");
    process.exit(2);
  }
  process.exit(await runLaunch(jobDir));
}
