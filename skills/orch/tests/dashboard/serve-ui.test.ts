import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, statSync, utimesSync, mkdirSync } from "node:fs";
import { orch, seedHome, tempDir, fakeBin, readText, runCmd, DISPATCH, pidAlive, waitUntil, autoCleanup } from "../helpers";
autoCleanup();

// A fake `bun` that records argv and a fake server marker, then sleeps; a fake curl answering 200.
const fakeServe = () => fakeBin({
  bun: `serve_dir=""
for arg in "$@"; do
  [ -n "\${want_home:-}" ] && { serve_dir="$arg/serve"; want_home=; }
  [ "$arg" = "--home" ] && want_home=1
done
mkdir -p "$serve_dir"
printf '%s\\n' "$@" > "$serve_dir/argv"
printf '0.0.0.0' > "$serve_dir/host"
printf '12345' > "$serve_dir/port"
printf '%s' "$$" > "$serve_dir/pid"
exec sleep 30`,
  curl: 'printf 200',
});

test("serve and ui lifecycle against a fake server", async () => {
  const home = seedHome();
  const shims = fakeServe();
  const srcfix = tempDir(); writeFileSync(join(srcfix, "main.ts"), "x\n"); utimesSync(join(srcfix, "main.ts"), new Date(2010, 0, 1), new Date(2010, 0, 1));
  const base = { ORCH_SERVE_SOURCE_DIRS: srcfix };
  const o = orch(home, base);
  const fo = orch(home, { ...base, PATH: `${shims}:${process.env.PATH}`, ORCH_BUN: join(shims, "bun"), ORCH_NO_OPEN: "1" });
  const fot = orch(home, { ...base, PATH: `${shims}:${process.env.PATH}`, ORCH_BUN: join(shims, "bun"), ORCH_NO_OPEN: "1", ORCH_REQUIRE_TOKEN: "1" });
  writeFileSync(join(home, "serve.token"), "testtoken", { mode: 0o600 });
  let r = o("serve", "--bogus"); expect(r.rc).toBe(2); expect(r.all).toMatch(/usage:/);
  expect(o("serve", "--port", "abc").rc).toBe(2); expect(o("serve", "--port", "70000").rc).toBe(2);
  expect(o("ui", "--bogus").rc).toBe(2); expect(o("ui", "--host", "127.0.0.1").rc).toBe(2); expect(o("ui", "--port", "6725").rc).toBe(2);
  r = o("serve", "--stop"); expect(r.rc).toBe(0); expect(r.all).toMatch(/not running/);
  r = o.env({ ORCH_BUN: "/nonexistent/bun" }, "serve"); expect(r.rc).toBe(127); expect(r.all).toMatch(/not found on PATH/);
  expect(o.env({ ORCH_BUN: "/nonexistent/bun" }, "ui").rc).toBe(127);
  r = fo("ui");
  expect(r.rc).toBe(0); expect(r.out).toMatch(/^http:\/\/127\.0\.0\.1:12345\/$/m);
  const argv = readText(join(home, "serve/argv")).split("\n");
  for (const a of ["--home", home, "0.0.0.0", "6724", "claude cursor-agent opencode local-llm copilot pi", "success failure partial"]) expect(argv).toContain(a);
  expect((statSync(join(home, "serve")).mode & 0o777).toString(8)).toBe("700");
  expect((statSync(join(home, "serve/log")).mode & 0o777).toString(8)).toBe("600");
  const firstPid = readText(join(home, "serve/pid"));
  r = fo("ui");
  expect(r.rc).toBe(0); expect(r.out).toMatch(/^http:\/\/127\.0\.0\.1:12345\/$/m);
  expect(readText(join(home, "serve/pid"))).toBe(firstPid);
  expect(readText(join(home, "serve/argv"))).not.toMatch(/^--require-token$/m);
  fo("ui", "--stop");
  r = fot("ui");
  expect(r.rc).toBe(0); expect(r.out).toMatch(/^http:\/\/127\.0\.0\.1:12345\/\?token=testtoken$/m);
  expect(readText(join(home, "serve/argv"))).toMatch(/^--require-token$/m);
  fo("ui", "--stop");
  o("serve", "config", "set", "--allow-remote"); fo("ui");
  expect(readText(join(home, "serve/argv"))).toMatch(/^--allow-remote$/m);
  fo("ui", "--stop"); o("serve", "config", "set", "--no-allow-remote");
  r = o("serve", "config", "show"); expect(r.rc).toBe(0); expect(r.out).toMatch(/"host"/);
  expect(o("serve", "config", "get", "port").out.trim()).toBe("6724");
  r = o("serve", "config", "set", "--host", "127.0.0.1", "--port", "8080"); expect(r.rc).toBe(0); expect(r.out).toMatch(/"host": "127.0.0.1"/);
  expect(o("serve", "config", "get", "host").out.trim()).toBe("127.0.0.1");
  o("serve", "config", "set", "--host", "0.0.0.0", "--port", "6724");
  fo("ui");
  const pid1 = readText(join(home, "serve/pid"));
  r = fo("serve"); expect(r.rc).toBe(1); expect(r.all).toMatch(/already running on 0\.0\.0\.0:12345/);
  utimesSync(join(home, "serve/pid"), new Date(2000, 0, 1), new Date(2000, 0, 1));
  r = fo("ui"); expect(r.rc).toBe(0); expect(r.all).toMatch(/restarting/);
  expect(readText(join(home, "serve/pid"))).not.toBe(pid1);
  const running = Number(readText(join(home, "serve/pid")));
  r = fo("ui", "--stop"); expect(r.rc).toBe(0); expect(r.all).toMatch(`stopped .pid ${running}`);
  await Bun.sleep(300);
  expect(pidAlive(running)).toBe(false);
  expect(readText(join(home, "serve/pid")).length).toBe(0);
  writeFileSync(join(home, "serve/pid"), "999999");
  r = fo("ui"); expect(r.rc).toBe(0); expect(readText(join(home, "serve/pid"))).not.toBe("999999");
  fo("ui", "--stop");
  r = fo("serve", "status"); expect(r.rc).toBe(1); expect(r.all).toMatch(/state=down/);
  r = fo("serve", "recover"); expect(r.rc).toBe(0); expect(r.out).toMatch(/^http:\/\/127\.0\.0\.1:12345\//m);
  r = fo("serve", "status"); expect(r.rc).toBe(0); expect(r.all).toMatch(/state=running listener=answering/);
  fo("ui", "--stop");
  writeFileSync(join(home, "serve/pid"), "999999");
  r = fo("serve", "status"); expect(r.rc).toBe(1); expect(r.all).toMatch(/stale_pid=999999/);
  expect(fo("serve", "recover").rc).toBe(0);
  fo("ui", "--stop");
  r = o("sync", "--no-serve"); expect(r.rc).toBe(0); expect(r.out.trim()).toBe("synced");
  const logBefore = statSync(join(home, "serve/log")).size;
  const fg = Bun.spawn(["bash", DISPATCH, "serve"], { env: { ...process.env, HARNESS_ORCH_HOME: home, PATH: `${shims}:${process.env.PATH}`, ORCH_BUN: join(shims, "bun"), ORCH_NO_OPEN: "1", ORCH_NO_ANNOUNCE: "1", ORCH_SERVE_SOURCE_DIRS: srcfix }, stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(2000);
  expect(readText(join(home, "serve/argv"))).toMatch(/^6724$/m);
  expect(statSync(join(home, "serve/log")).size).toBe(logBefore);
  fo("serve", "--stop");
  await fg.exited.catch(() => {});
}, 180000);
