// Hidden `adapter-util <verb>` entry: lets the remaining bash libs call the ported adapter code
// (prompt files, binary lookup, hub mode and calls, hub node hooks, profile dispatch).
import { orchHome, paths } from "../state/home.ts";
import { readCatalog } from "../adapters/routing.ts";
import { harnessFindBinary } from "../adapters/harness.ts";
import { HubError, hubApi, hubModeOn, hubNodeExpect, hubNodeSettle, hubProfile, hubRoleTier } from "../adapters/hub.ts";
import { dispatchWithProfile, loadEnv, resolvePrompt } from "../adapters/spawn.ts";

export async function adapterUtil(a: string[]): Promise<number> {
  const home = orchHome();
  const cat = async () => readCatalog(paths.profiles(home)).catch(() => ({}) as any);
  const line = (s: string) => (process.stdout.write(s + "\n"), 0);
  switch (a[0]) {
    case "resolve-prompt": {
      const p = await resolvePrompt(a[1] ?? "");
      if (p === null) return 1;
      process.stdout.write(p);
      return 0;
    }
    case "find-binary": {
      const p = harnessFindBinary(a[1] ?? "");
      return p ? line(p) : 1;
    }
    case "hub-mode-on": return hubModeOn(await cat()) ? 0 : 1;
    case "hub-profile": return line(hubProfile(await cat()));
    case "hub-role-tier": return line(hubRoleTier(await cat(), a[1] ?? ""));
    case "hub-api":
      try {
        process.stdout.write(await hubApi(await loadEnv(home), a[1] ?? "GET", a[2] ?? "/", a[3]));
        return 0;
      } catch (e) {
        if (e instanceof HubError && e.rc === 2) process.stderr.write(e.message);
        return e instanceof HubError ? e.rc : 1;
      }
    case "hub-node-expect": return hubNodeExpect(a[1] ?? "", a[2] ?? "", a[3] ?? "", a[4] ?? "", a[5] ?? "");
    case "hub-node-settle": return hubNodeSettle(a[1] ?? "", a[2] ?? "", a[3] ?? "");
    case "dispatch-with-profile": return dispatchWithProfile(home, a[1] ?? "", a[2] ?? "", a.slice(3), await loadEnv(home));
    default:
      process.stderr.write("usage: adapter-util resolve-prompt|find-binary|hub-mode-on|hub-profile|hub-role-tier|hub-api|hub-node-expect|hub-node-settle|dispatch-with-profile ...\n");
      return 2;
  }
}
