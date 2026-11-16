// Fake `herdr` binary for the runner tests: keeps workspaces/tabs/panes in $HOME/.config/herdr/fake/state.json,
// logs every call to $ORCH_HERDR_FAKE_LOG, serves a "socket" file with the server pid.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const a = process.argv.slice(2), e = process.env;
const cfg = join(e.HOME!, ".config/herdr"), S = join(cfg, "fake"), sock = join(cfg, "herdr.sock"), stateF = join(S, "state.json");
mkdirSync(S, { recursive: true });
appendFileSync(e.ORCH_HERDR_FAKE_LOG ?? "/dev/null", `HOME=${e.HOME} sock=${sock} socketenv=${e.HERDR_SOCKET_PATH ?? ""} :: ${a.join(" ")}\n`);
if (!existsSync(stateF)) writeFileSync(stateF, JSON.stringify({ workspaces: [], tabs: [], panes: [], next: 1 }));
const load = () => JSON.parse(readFileSync(stateF, "utf8"));
const save = (s: any) => { writeFileSync(stateF + ".tmp", JSON.stringify(s)); renameSync(stateF + ".tmp", stateF); };
const nid = () => { const s = load(); const n = s.next; s.next++; save(s); return n; };
const label = () => { const i = a.indexOf("--label"); return i >= 0 ? a[i + 1] : ""; };
const out = (o: unknown) => console.log(JSON.stringify(o));
const k = a.slice(0, 2).join(" ");
const serverUp = () => { try { process.kill(Number(readFileSync(sock, "utf8")), 0); return true; } catch { return false; } };

switch (k) {
  case "server stop": try { renameSync(sock, sock + ".stopped"); } catch {} break;
  case "status --json": out({ server: { running: serverUp() } }); break;
  case "workspace list": out({ result: { workspaces: load().workspaces } }); break;
  case "workspace create": {
    const n = nid(), s = load(), w = `w${n}`;
    s.workspaces.push({ workspace_id: w, label: label() }); s.tabs.push({ tab_id: `${w}:t1`, workspace_id: w, label: "1" }); s.panes.push({ pane_id: `${w}:p1`, tab_id: `${w}:t1` }); save(s);
    out({ result: { workspace: { workspace_id: w }, tab: { tab_id: `${w}:t1` }, root_pane: { pane_id: `${w}:p1` } } }); break;
  }
  case "tab rename": { const s = load(); const t = s.tabs.find((x: any) => x.tab_id === a[2]); if (t) t.label = "[1] " + a[3]; save(s); out({}); break; }
  case "tab list": out({ result: { tabs: load().tabs.filter((t: any) => t.workspace_id === a[3]) } }); break;
  case "tab close": { const s = load(); s.tabs = s.tabs.filter((t: any) => t.tab_id !== a[2]); s.panes = s.panes.filter((p: any) => p.tab_id !== a[2]); save(s); out({}); break; }
  case "tab create": {
    const n = nid(), w = a[3], s = load();
    s.tabs.push({ tab_id: `${w}:t${n}`, workspace_id: w, label: label() }); s.panes.push({ pane_id: `${w}:p${n}`, tab_id: `${w}:t${n}` }); save(s);
    out({ result: { tab: { tab_id: `${w}:t${n}` }, root_pane: { pane_id: `${w}:p${n}` } } }); break;
  }
  case "pane list": out({ result: { panes: load().panes } }); break;
  case "pane split": {
    const n = nid(), s = load(), src = a[2], tab = s.panes.find((p: any) => p.pane_id === src)?.tab_id, id = `${src.split(":")[0]}:p${n}`;
    s.panes.push({ pane_id: id, tab_id: tab }); save(s); out({ result: { pane: { pane_id: id } } }); break;
  }
  case "pane rename": { const s = load(); const p = s.panes.find((x: any) => x.pane_id === a[2]); if (p) p.label = a[3]; save(s); out({}); break; }
  case "pane close": {
    const s = load(); s.panes = s.panes.filter((p: any) => p.pane_id !== a[2]);
    s.tabs = s.tabs.filter((t: any) => s.panes.some((p: any) => p.tab_id === t.tab_id));
    s.workspaces = s.workspaces.filter((w: any) => s.tabs.some((t: any) => t.workspace_id === w.workspace_id)); save(s); out({ result: { type: "ok" } }); break;
  }
  case "pane read": { const f = join(S, `pane-${a[2]}.out`); if (existsSync(f)) process.stdout.write(readFileSync(f, "utf8")); break; }
  case "pane run": {
    const fd = require("node:fs").openSync(join(S, `pane-${a[2]}.out`), "w");
    spawn("bash", ["-c", a[3]], { detached: true, stdio: ["ignore", fd, fd] }).unref(); out({}); break;
  }
  default:
    if (a[0] === "server") {
      if (e.ORCH_HERDR_FAKE_DOWN) process.exit(1);
      appendFileSync(join(S, "starts"), "x\n");
      await Bun.sleep(300);
      writeFileSync(sock, String(process.pid));
      while (existsSync(sock)) await Bun.sleep(200);
      process.exit(0);
    }
    console.error(`fake herdr: unsupported ${a.join(" ")}`); process.exit(2);
}
