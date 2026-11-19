import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { tempDir, fakeBin, runCmd, REPO_ROOT, waitUntil, pidAlive, readText, autoCleanup } from "../helpers";
autoCleanup();

const svcCmd = () => (existsSync(join(REPO_ROOT, "scripts/service.ts")) ? ["bun", join(REPO_ROOT, "scripts/service.ts")] : ["bash", join(REPO_ROOT, "scripts/service.sh")]);
const darwin = platform() === "darwin";
const dt = darwin ? test : test.skip;

dt("service restart with a fake launchctl", () => {
  const svcHome = tempDir(), state = tempDir();
  mkdirSync(join(svcHome, "Library/LaunchAgents"), { recursive: true }); mkdirSync(join(svcHome, "orch"), { recursive: true });
  writeFileSync(join(svcHome, "Library/LaunchAgents/io.github.barnuri.orch.plist"), "");
  const bin = fakeBin({ launchctl: `st="$SVC_STATE"
case "$1" in
  print) if [ -f "$st/unload_left" ]; then n=$(cat "$st/unload_left"); if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$st/unload_left"; exit 0; fi; rm -f "$st/loaded" "$st/unload_left"; exit 113; fi; [ -f "$st/loaded" ] ;;
  bootout) echo bootout >> "$st/calls"; [ -f "$st/loaded" ] || exit 3; echo 2 > "$st/unload_left" ;;
  bootstrap) echo bootstrap >> "$st/calls"; [ -z "\${BOOTSTRAP_FAIL:-}" ] && [ ! -f "$st/loaded" ] || exit 5; : > "$st/loaded" ;;
  kickstart) echo kickstart >> "$st/calls"; [ -f "$st/loaded" ] && [ -z "\${KICKSTART_FAIL:-}" ] || exit 113 ;;
  load) echo load >> "$st/calls" ;;
  *) exit 0 ;;
esac` });
  const reset = () => Bun.spawnSync(["sh", "-c", `rm -f "${state}"/*`]);
  const restart = (extra: Record<string, string> = {}) => runCmd([...svcCmd(), "restart"], { env: { HOME: svcHome, HARNESS_ORCH_HOME: join(svcHome, "orch"), SVC_STATE: state, PATH: `${bin}:${process.env.PATH}`, ...extra } });
  reset(); writeFileSync(join(state, "loaded"), "");
  let r = restart();
  expect(r.rc).toBe(0);
  expect(readText(join(state, "calls"))).toMatch(/kickstart/); expect(readText(join(state, "calls"))).not.toMatch(/bootout/);
  reset(); r = restart(); expect(r.rc).toBe(0); expect(existsSync(join(state, "loaded"))).toBe(true);
  reset(); writeFileSync(join(state, "loaded"), "");
  r = restart({ KICKSTART_FAIL: "1" }); expect(r.rc).toBe(0); expect(existsSync(join(state, "loaded"))).toBe(true);
  reset(); r = restart({ BOOTSTRAP_FAIL: "1" });
  expect(r.rc).toBe(1); expect(r.all).not.toMatch(/restarted/);
}, 30_000);

// A real throwaway launchd label proves AbandonProcessGroup keeps children alive across a kickstart.
dt("launchd: AbandonProcessGroup keeps job children alive across a restart", async () => {
  const T = tempDir();
  const uid = Bun.spawnSync(["id", "-u"]).stdout.toString().trim();
  const labels: string[] = [];
  const survive = async (label: string, abandon: boolean) => {
    const d = join(T, label), plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "server.sh"), `echo $$ > "${d}/server.pid"
[ -e "${d}/setsid.pid" ] && exec sleep 300
sleep 300 & echo $! > "${d}/plain.pid"
perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' sleep 300 </dev/null >/dev/null 2>&1 &
echo $! > "${d}/setsid.pid"
wait
`);
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/bin/bash</string><string>${join(d, "server.sh")}</string></array>
<key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>1</integer><key>RunAtLoad</key><true/>${abandon ? "<key>AbandonProcessGroup</key><true/>" : ""}</dict></plist>`);
    labels.push(label);
    expect(runCmd(["launchctl", "bootstrap", `gui/${uid}`, plist]).rc).toBe(0);
    await waitUntil(() => existsSync(join(d, "setsid.pid")) && readText(join(d, "setsid.pid")).trim() !== "", 15);
    const s1 = readText(join(d, "server.pid")).trim();
    runCmd(["launchctl", "kickstart", "-k", `gui/${uid}/${label}`]);
    await waitUntil(() => readText(join(d, "server.pid")).trim() !== s1, 20);
    await Bun.sleep(300);
    const res = ["plain", "setsid"].map((n) => `${n}=${pidAlive(Number(readText(join(d, `${n}.pid`)).trim())) ? "alive" : "dead"}`).join(" ");
    for (const n of ["plain", "setsid"]) try { process.kill(Number(readText(join(d, `${n}.pid`)).trim())); } catch {}
    runCmd(["launchctl", "bootout", `gui/${uid}/${label}`]);
    return res;
  };
  try {
    const rid = `${Math.floor(Math.random() * 1e9)}`;
    const before = await survive(`com.orch.test.before${rid}`, false);
    const after = await survive(`com.orch.test.after${rid}`, true);
    expect(before).toMatch(/plain=dead/);
    expect(after).toBe("plain=alive setsid=alive");
  } finally {
    for (const l of labels) { runCmd(["launchctl", "bootout", `gui/${uid}/${l}`]); Bun.spawnSync(["trash", join(homedir(), "Library/LaunchAgents", `${l}.plist`)]); }
  }
}, 120000);
