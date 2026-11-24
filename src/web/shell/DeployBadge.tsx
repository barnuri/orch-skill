import type { DeployInfo } from "../../shared/types/build-info";
import { useBuild } from "./use-build";

/** Header text for the deploy state: "deployed abc1234 · 2 commits behind master · deploy failed: reason". */
export function deployText(d: DeployInfo | null | undefined): string {
  if (!d) return "";
  const parts: string[] = [];
  if (d.short !== null) parts.push(`deployed ${d.short}`);
  if (d.behind !== null && d.behind > 0) parts.push(`${d.behind} ${d.behind === 1 ? "commit" : "commits"} behind master`);
  if (d.failed !== null) parts.push(`deploy failed: ${d.failed}`);
  return parts.join(" · ");
}

/** Amber when master is ahead or the last deploy failed (never red: it is not an error state of a run). */
export function DeployBadge() {
  const build = useBuild();
  const d = build.data?.deploy ?? null;
  const text = deployText(d);
  if (text === "") return null;
  const warn = d !== null && (d.failed !== null || (d.behind ?? 0) > 0);
  return (
    <span className="deploy-badge" data-warn={warn ? "1" : undefined} title={d?.deployed_at ?? ""} style={{ fontSize: "0.8em", color: warn ? "var(--wa)" : "var(--status-done)" }}>
      {text}
    </span>
  );
}
