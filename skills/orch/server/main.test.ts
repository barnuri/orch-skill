import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { TempHome } from "./test-support/temp-home";

const ENTRY: string = resolve(import.meta.dir, "main.ts");
const HARNESSES: string = "claude cursor-agent opencode";
const OUTCOMES: string = "good bad";
const URL_PATTERN = /^http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)$/m;
const READY_TIMEOUT_MS: number = 10_000;
const POLL_MS: number = 25;
const SIGTERM_GRACE_MS: number = 2000;

type Started = {
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  port: number;
  token: string;
  stderr: string;
};

const homes: TempHome[] = [];
const running: Bun.Subprocess[] = [];

function tempHome(): TempHome {
  const home = TempHome.create();
  homes.push(home);
  return home;
}

function spawnServe(argv: readonly string[]): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  const proc = Bun.spawn([process.execPath, ENTRY, ...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  running.push(proc);
  return proc;
}

// Reads one line at a time so the test never blocks on a stream that stays open for the
// process's whole life — `text()` would only resolve at exit.
async function readUntil(stream: ReadableStream<Uint8Array>, pattern: RegExp): Promise<string> {
  const decoder = new TextDecoder();
  let seen = "";
  for await (const chunk of stream) {
    seen += decoder.decode(chunk, { stream: true });
    if (pattern.test(seen)) {
      return seen;
    }
  }
  return seen;
}

// Port 0 so parallel test files never collide on 6724.
async function startServe(home: TempHome, extra: readonly string[] = []): Promise<Started> {
  const proc = spawnServe([
    "--home",
    home.path,
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--harnesses",
    HARNESSES,
    "--outcomes",
    OUTCOMES,
    ...extra,
  ]);
  const stdout = await readUntil(proc.stdout, URL_PATTERN);
  const match = URL_PATTERN.exec(stdout);
  if (match?.[1] === undefined || match[2] === undefined) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`serve did not print a URL.\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
  const stderr = await readUntil(proc.stderr, /Ctrl-C to stop\./);
  return { proc, port: Number(match[1]), token: match[2], stderr };
}

async function waitForPidCleared(home: TempHome): Promise<string> {
  const deadline = Date.now() + SIGTERM_GRACE_MS;
  while (Date.now() < deadline) {
    if (home.read("serve/pid").trim() === "") {
      return "";
    }
    await Bun.sleep(POLL_MS);
  }
  return home.read("serve/pid").trim();
}

afterEach(() => {
  for (const proc of running.splice(0)) {
    proc.kill("SIGKILL");
  }
  for (const home of homes.splice(0)) {
    home.dispose();
  }
});

describe("main argv handling", () => {
  test("an unknown flag exits 2 with the usage line", async () => {
    const proc = spawnServe(["--bogus"]);
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(code).toBe(2);
    expect(stderr).toContain("usage:");
  });

  test("a missing --home exits 2", async () => {
    const proc = spawnServe(["--harnesses", HARNESSES, "--outcomes", OUTCOMES]);
    expect(await proc.exited).toBe(2);
  });

  test("a bad --port exits 2 without creating the home", async () => {
    const home = tempHome();
    const proc = spawnServe([
      "--home",
      home.resolve("fresh"),
      "--port",
      "70000",
      "--harnesses",
      HARNESSES,
      "--outcomes",
      OUTCOMES,
    ]);
    expect(await proc.exited).toBe(2);
    expect(existsSync(home.resolve("fresh"))).toBe(false);
  });
});

describe("main startup", () => {
  test(
    "it seeds the home, mints a 0600 token and serves health",
    async () => {
      const home = tempHome();
      const started = await startServe(home);

      expect(home.mode("serve.token")).toBe(0o600);
      expect(home.read("serve.token").trim()).toBe(started.token);
      expect(existsSync(home.resolve("profiles.json"))).toBe(true);
      expect(existsSync(home.resolve("memory.json"))).toBe(true);

      const res = await fetch(`http://127.0.0.1:${started.port}/api/health`, {
        headers: { authorization: `Bearer ${started.token}` },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).pid).toBe(started.proc.pid);
    },
    READY_TIMEOUT_MS,
  );

  test(
    "the markers name the live host, port and pid",
    async () => {
      const home = tempHome();
      const started = await startServe(home);
      expect(home.read("serve/host").trim()).toBe("127.0.0.1");
      expect(home.read("serve/port").trim()).toBe(String(started.port));
      expect(home.read("serve/pid").trim()).toBe(String(started.proc.pid));
    },
    READY_TIMEOUT_MS,
  );

  // The token belongs on stdout only, where bash captures it; the banner must not leak it.
  test(
    "the stderr banner warns about plain HTTP without repeating the token",
    async () => {
      const home = tempHome();
      const started = await startServe(home);
      expect(started.stderr).toContain("plain HTTP");
      expect(started.stderr).toContain(`${home.path}/serve.token`);
      expect(started.stderr).not.toContain(started.token);
    },
    READY_TIMEOUT_MS,
  );

  test(
    "a port already bound exits 1 with the address in the message",
    async () => {
      const home = tempHome();
      const started = await startServe(home);
      const second = spawnServe([
        "--home",
        tempHome().path,
        "--host",
        "127.0.0.1",
        "--port",
        String(started.port),
        "--harnesses",
        HARNESSES,
        "--outcomes",
        OUTCOMES,
      ]);
      const [code, stderr] = await Promise.all([
        second.exited,
        new Response(second.stderr).text(),
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain(`cannot bind 127.0.0.1:${started.port}`);
    },
    READY_TIMEOUT_MS,
  );
});

describe("main shutdown", () => {
  test(
    "SIGTERM stops the server and truncates its own pid marker",
    async () => {
      const home = tempHome();
      const started = await startServe(home);

      started.proc.kill("SIGTERM");
      expect(await started.proc.exited).toBe(0);

      // Truncated, never deleted — `serve_running` reads the file's mtime.
      expect(await waitForPidCleared(home)).toBe("");
      expect(existsSync(home.resolve("serve/pid"))).toBe(true);
      expect(fetch(`http://127.0.0.1:${started.port}/api/health`)).rejects.toThrow();
    },
    READY_TIMEOUT_MS,
  );

  // A restart that already claimed the marker must survive the old process exiting late.
  test(
    "a pid marker owned by another process is left alone",
    async () => {
      const home = tempHome();
      const started = await startServe(home);
      home.write("serve/pid", "999999");

      started.proc.kill("SIGTERM");
      expect(await started.proc.exited).toBe(0);
      expect(home.read("serve/pid").trim()).toBe("999999");
    },
    READY_TIMEOUT_MS,
  );
});
