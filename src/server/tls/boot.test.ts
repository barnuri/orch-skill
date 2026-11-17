import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const MAIN = resolve(import.meta.dir, "../main.ts");
const TEMPLATES = resolve(import.meta.dir, "../../../skills/orch/templates");

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const p = s.port as number;
  void s.stop(true);
  return p;
}

async function boot(serveJson: Record<string, unknown>, httpPort: number) {
  const home = mkdtempSync(join(tmpdir(), "orch-boot-"));
  writeFileSync(join(home, "serve.json"), JSON.stringify(serveJson));
  const proc = Bun.spawn(
    [process.execPath, MAIN, "--home", home, "--host", "127.0.0.1", "--port", String(httpPort), "--harnesses", "claude", "--outcomes", "success"],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ORCH_HERDR: "0", HARNESS_ORCH_HOME: home } },
  );
  let up = false;
  for (let i = 0; i < 150 && !up && proc.exitCode === null; i++) {
    try {
      up = (await fetch(`http://127.0.0.1:${httpPort}/api/health`, { signal: AbortSignal.timeout(1000) })).status === 200;
    } catch {
      await Bun.sleep(200);
    }
  }
  return { home, proc, up };
}

async function stop(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  proc.kill("SIGTERM");
  await proc.exited;
}

describe("a fresh server process always starts HTTP", () => {
  test("https_port 0: HTTP answers and no TLS file or status is made", async () => {
    const port = freePort();
    const { home, proc, up } = await boot({ https_port: 0 }, port);
    try {
      expect(up).toBe(true);
      expect(await Bun.file(join(home, "tls")).exists()).toBe(false);
      const info = (await (await fetch(`http://127.0.0.1:${port}/api/server-info`)).json()) as Record<string, unknown>;
      expect([info["https_port"], info["https_url"]]).toEqual([0, null]);
    } finally {
      await stop(proc);
    }
  }, 60_000);

  test("a broken certificate path: HTTP still answers, status says why", async () => {
    const port = freePort();
    const { home, proc, up } = await boot({ https_port: freePort(), tls_mode: "files", tls_cert: "/nonexistent/c.pem", tls_key: "/nonexistent/k.pem" }, port);
    try {
      expect(up).toBe(true);
      const statusFile = join(home, "serve", "tls.json");
      for (let i = 0; i < 150 && !(existsSync(statusFile) && readFileSync(statusFile, "utf8").includes("cannot be read")); i++) {
        await Bun.sleep(200);
      }
      const st = JSON.parse(readFileSync(statusFile, "utf8")) as { listening: boolean; problem: string };
      expect(st.listening).toBe(false);
      expect(st.problem).toContain("cannot be read");
      expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
    } finally {
      await stop(proc);
    }
  }, 60_000);

  test("a busy HTTPS port: HTTP still answers", async () => {
    const busy = Bun.serve({ port: 0, hostname: "0.0.0.0", fetch: () => new Response("x") });
    const port = freePort();
    const { proc, up } = await boot({ https_port: busy.port, tls_mode: "localca" }, port);
    try {
      expect(up).toBe(true);
    } finally {
      await stop(proc);
      await busy.stop(true);
    }
  }, 60_000);

  test("https_port set with the local CA: both listeners answer from a fresh process", async () => {
    const port = freePort();
    const https = freePort();
    const { proc, up } = await boot({ https_port: https, tls_mode: "localca" }, port);
    try {
      expect(up).toBe(true);
      let status = 0;
      for (let i = 0; i < 150 && status !== 200; i++) {
        try {
          status = (await fetch(`https://127.0.0.1:${https}/api/health`, { tls: { rejectUnauthorized: false } } as RequestInit)).status;
        } catch {
          await Bun.sleep(200);
        }
      }
      expect(status).toBe(200);
    } finally {
      await stop(proc);
    }
  }, 60_000);

  test("only gen.ts imports the certificate library, and nobody imports gen.ts statically", () => {
    const dir = resolve(import.meta.dir);
    const root = resolve(import.meta.dir, "../..");
    const all = new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: root });
    for (const rel of all) {
      if (rel.includes("node_modules") || /\.test\./.test(rel)) continue;
      const text = readFileSync(join(root, rel), "utf8");
      if (rel !== "server/tls/gen.ts") {
        expect(text).not.toMatch(/from "@peculiar|import "reflect-metadata"/);
        expect(text).not.toMatch(/^import[^\n]*from "\.\/gen"/m);
      }
    }
    expect(dir.endsWith("tls")).toBe(true);
  });
});
