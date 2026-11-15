import type { RunEnvelope } from "../../shared/types/run-envelope";
import type { RunsEnvelope } from "../../shared/types/runs-envelope";
import type { DocumentKind } from "../../shared/types/document-kind";
import type { RouteHandler } from "../http/route";
import { getDocumentHandler } from "../routes/document-routes";
import { listHarnessesHandler } from "../routes/harnesses-routes";
import {
  listRunsHandler,
  readJobChatHandler,
  readJobLogHandler,
  readRunHandler,
} from "../routes/runs-routes";
import type { ServerContext } from "../types/server-context";

export type IslandSet = Record<string, unknown>;

export type IslandBuildResult =
  | { kind: "ok"; islands: IslandSet }
  | { kind: "missing-run"; runId: string };

/**
 * Collects every API document an emitted artifact needs, by calling the same route handlers the
 * live server does. Driving the real handlers — rather than re-deriving their envelopes here —
 * is what keeps a snapshot byte-identical in shape to a live response as the routes evolve.
 *
 * `health` is deliberately absent: it reports the state directory's absolute path and the server
 * pid, neither of which belongs in a page that gets published.
 */
export class IslandBuilder {
  /** `Request` demands an absolute URL; no socket is involved, so the host is arbitrary. */
  private static readonly SYNTHETIC_URL: string = "http://artifact.invalid/";
  private static readonly DOCUMENT_KINDS: readonly DocumentKind[] = [
    "profiles",
    "memory",
    "suggestions",
  ];

  private readonly ctx: ServerContext;

  constructor(ctx: ServerContext) {
    this.ctx = ctx;
  }

  /**
   * A handler that throws is a 500 on the live server, which `Bun.serve`'s error hook turns into
   * a response. Nothing catches it here, so this does: a document whose file is absent — an older
   * state dir has no `suggestions.json` — must leave its island out, not abort the whole emit.
   */
  private static async bodyOf(
    handler: RouteHandler,
    params: Readonly<Record<string, string>> = {},
  ): Promise<unknown | null> {
    let response: Response;
    try {
      response = await handler(new Request(IslandBuilder.SYNTHETIC_URL), params);
    } catch (err) {
      if (err instanceof Error) {
        return null;
      }
      throw err;
    }
    if (!response.ok) {
      return null;
    }
    return await response.json();
  }

  /**
   * Every document for one run. The `runs` list is narrowed to that run: the snapshot carries
   * only its detail, so listing siblings would render links that cannot resolve offline.
   */
  async forRun(runId: string): Promise<IslandBuildResult> {
    const run = (await IslandBuilder.bodyOf(readRunHandler(this.ctx), { id: runId })) as
      | RunEnvelope
      | null;
    if (run === null) {
      return { kind: "missing-run", runId };
    }
    const islands: IslandSet = { [`run-${runId}`]: run };
    await this.addRunsList(islands, runId);
    await this.addJobLogs(islands, run);
    await this.addDocuments(islands);
    await this.addHarnesses(islands);
    return { kind: "ok", islands };
  }

  private async addRunsList(islands: IslandSet, runId: string): Promise<void> {
    const listed = (await IslandBuilder.bodyOf(listRunsHandler(this.ctx))) as RunsEnvelope | null;
    if (listed === null) {
      return;
    }
    islands["runs"] = {
      generated_at: listed.generated_at,
      runs: listed.runs.filter((summary) => summary.run_id === runId),
    };
  }

  private async addJobLogs(islands: IslandSet, run: RunEnvelope): Promise<void> {
    const logHandler = readJobLogHandler(this.ctx);
    const chatHandler = readJobChatHandler(this.ctx);
    for (const node of run.run.nodes) {
      const jobId = node.job_id;
      if (jobId === null || jobId === "") {
        continue;
      }
      const log = await IslandBuilder.bodyOf(logHandler, { id: jobId });
      // A pruned or never-written log is simply absent; the node panel already falls back to
      // the tail state.json keeps.
      if (log !== null) {
        islands[`job-${jobId}-log`] = log;
      }
      // Only a claude node has a session transcript, so this is absent for most nodes and the
      // snapshot's Chat tab falls back to the output the same way the live page does.
      const chat = await IslandBuilder.bodyOf(chatHandler, { id: jobId });
      if (chat !== null) {
        islands[`job-${jobId}-chat`] = chat;
      }
    }
  }

  private async addDocuments(islands: IslandSet): Promise<void> {
    for (const kind of IslandBuilder.DOCUMENT_KINDS) {
      const document = await IslandBuilder.bodyOf(getDocumentHandler(this.ctx, kind));
      if (document !== null) {
        islands[kind] = document;
      }
    }
  }

  private async addHarnesses(islands: IslandSet): Promise<void> {
    const harnesses = await IslandBuilder.bodyOf(listHarnessesHandler(this.ctx));
    if (harnesses !== null) {
      islands["harnesses"] = harnesses;
    }
  }
}
