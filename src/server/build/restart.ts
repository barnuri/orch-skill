import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { MANUAL_START_COMMAND, RESTART_COMMAND } from "../../shared/build-commands";

export const RESTART_DELAY_MS: number = 1000;
export const RESTART_COOLDOWN_MS: number = 60_000;
const NOT_INSTALLED_CACHE_MS = 30_000;
export const LOG_CAP_BYTES: number = 100 * 1024;
const PROBE_TIMEOUT_MS = 5000;

export const REPO_ROOT: string = resolve(import.meta.dir, "../../..");
export const SERVICE_COMMAND: string = RESTART_COMMAND;
export const MANUAL_COMMAND: string = MANUAL_START_COMMAND;

export type RestartOutcome = { kind: "accepted" } | { kind: "already" } | { kind: "not_installed" };

/** ORCH_SERVICE_SH exists only so tests never touch the real supervisor. */
export function serviceScript(): string {
  return process.env["ORCH_SERVICE_SH"] ?? join(REPO_ROOT, "scripts", "service.sh");
}

export function capLog(path: string): void {
  try {
    if (statSync(path).size > LOG_CAP_BYTES) {
      const keep = readFileSync(path).subarray(-Math.floor(LOG_CAP_BYTES / 2));
      writeFileSync(path, keep);
    }
  } catch {
    // no log yet
  }
}

export class Restarter {
  private lastRequestedAt: number | null = null;
  private pending = false;
  private notInstalledAt: number | null = null;

  constructor(private readonly home: string, private readonly script: () => string = serviceScript) {}

  private async installed(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["bash", this.script(), "status"], {
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, HARNESS_ORCH_HOME: this.home },
      });
      const timer = setTimeout(() => {
        proc.kill();
      }, PROBE_TIMEOUT_MS);
      try {
        return (await proc.exited) === 0;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  async request(): Promise<RestartOutcome> {
    if (this.pending || (this.lastRequestedAt !== null && Date.now() - this.lastRequestedAt < RESTART_COOLDOWN_MS)) {
      return { kind: "already" };
    }
    this.pending = true;
    try {
      if (this.notInstalledAt !== null && Date.now() - this.notInstalledAt < NOT_INSTALLED_CACHE_MS) {
        return { kind: "not_installed" };
      }
      if (!(await this.installed())) {
        this.notInstalledAt = Date.now();
        return { kind: "not_installed" };
      }
      this.notInstalledAt = null;
      this.lastRequestedAt = Date.now();
    } finally {
      this.pending = false;
    }
    setTimeout(() => {
      this.launch();
    }, RESTART_DELAY_MS).unref();
    return { kind: "accepted" };
  }

  private launch(): void {
    const log = join(this.home, "restart.log");
    try {
      capLog(log);
      appendFileSync(log, `[${new Date().toISOString()}] restart requested from the dashboard (pid ${process.pid})\n`);
      const fd = openSync(log, "a");
      const useSystemd = process.platform === "linux" && Bun.which("systemd-run") !== null;
      const argv = useSystemd
        ? ["systemd-run", "--user", "--collect", "--pipe", `--setenv=HARNESS_ORCH_HOME=${this.home}`, "bash", this.script(), "restart"]
        : ["bash", this.script(), "restart"];
      const child = spawn(argv[0] ?? "bash", argv.slice(1), {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, HARNESS_ORCH_HOME: this.home },
      });
      child.on("error", () => undefined);
      child.unref();
      closeSync(fd);
    } catch (err) {
      console.error(`build: restart could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
