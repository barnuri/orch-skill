import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RequirementView, RunRequirementsEnvelope } from "../../shared/types/run-requirements";
import type { RouteHandler } from "../http/route";
import { jsonResponse, notFound } from "../http/responses";
import type { ServerContext } from "../types/server-context";
import { readRun } from "./runs-reader";

const OK = ["handled", "superseded", "waived"];

function handoffExists(dir: string): boolean {
  try {
    return statSync(join(dir, "handoff.md")).size > 0;
  } catch {
    return false;
  }
}

/** `GET /api/runs/{id}/requirements`: the ledger written by `dispatch.ts req *`, read only. 404 for an unknown run. */
export function readRequirementsHandler(ctx: ServerContext): RouteHandler {
  return (_req: Request, params: Readonly<Record<string, string>>): Promise<Response> => {
    const id = params.id ?? "";
    const loaded = readRun(ctx.paths, id);
    if (loaded.kind === "missing") {
      return Promise.resolve(notFound());
    }
    const runDir = join(ctx.paths.runs, id);
    let raw: any[] = [];
    const file = join(runDir, "requirements.json");
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        raw = Array.isArray(parsed?.requirements) ? parsed.requirements : [];
      } catch {
        raw = [];
      }
    }
    const nodes: any[] = loaded.kind === "ok" ? ((loaded.run as { nodes?: any[] }).nodes ?? []) : [];
    const requirements: RequirementView[] = raw.map((r) => ({
      id: String(r.id),
      text: String(r.text ?? ""),
      status: String(r.status ?? "not"),
      reason: r.reason ?? null,
      ok: OK.includes(r.status),
      evidence: Array.isArray(r.evidence) ? r.evidence : [],
      nodes: (Array.isArray(r.nodes) ? r.nodes : []).map((nid: string) => {
        const n = nodes.find((x) => x.id === nid);
        const out = typeof n?.out_dir === "string" && n.out_dir !== "" ? n.out_dir : join(runDir, "out", nid);
        return { id: nid, status: n?.status ?? "missing", done: n?.status === "done", handoff: n ? handoffExists(out) : false, unverified: n?.unverified === true };
      }),
    }));
    const body: RunRequirementsEnvelope = { generated_at: new Date().toISOString(), requirements };
    return Promise.resolve(jsonResponse(200, body));
  };
}
