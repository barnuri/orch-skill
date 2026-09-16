import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { islandElementId } from "../../shared/island-id";
import type { IslandSet } from "./island-builder";

export type EmitResult =
  | { kind: "ok"; indexPath: string; islandNames: string[] }
  | { kind: "bundle-failed"; message: string }
  | { kind: "no-head" };

/**
 * Bundles the dashboard into a directory and splices the run's documents into the emitted
 * `index.html` as JSON islands, producing a page that renders with no server behind it.
 */
export class ArtifactEmitter {
  static readonly INDEX_FILE: string = "index.html";
  private static readonly HEAD_CLOSE: string = "</head>";
  private static readonly DASHBOARD_ENTRY: string = resolve(
    import.meta.dir,
    "../../dashboard/index.html",
  );
  /**
   * A value anywhere in the data could contain the literal `</script>`, which would end the
   * island element early and inject the remainder as markup. Escaping every `<` as a JSON
   * unicode escape keeps the text an exact JSON equivalent while making that impossible.
   */
  private static readonly UNSAFE_MARKUP = /</g;
  private static readonly UNSAFE_MARKUP_ESCAPE: string = "\\u003c";

  static islandMarkup(name: string, value: unknown): string {
    const json = JSON.stringify(value).replace(
      ArtifactEmitter.UNSAFE_MARKUP,
      ArtifactEmitter.UNSAFE_MARKUP_ESCAPE,
    );
    return `<script type="application/json" id="${islandElementId(name)}">${json}</script>`;
  }

  /** Islands go in `<head>`, so they are parsed before the deferred module bundle runs. */
  static spliceIslands(html: string, islands: IslandSet): string | null {
    const index = html.lastIndexOf(ArtifactEmitter.HEAD_CLOSE);
    if (index === -1) {
      return null;
    }
    const blocks = Object.entries(islands)
      .map(([name, value]) => ArtifactEmitter.islandMarkup(name, value))
      .join("\n");
    return `${html.slice(0, index)}${blocks}\n${html.slice(index)}`;
  }

  async emit(outDir: string, islands: IslandSet): Promise<EmitResult> {
    const built = await Bun.build({
      entrypoints: [ArtifactEmitter.DASHBOARD_ENTRY],
      outdir: outDir,
      target: "browser",
    });
    if (!built.success) {
      return { kind: "bundle-failed", message: built.logs.map((log) => String(log)).join("; ") };
    }
    const indexPath = join(outDir, ArtifactEmitter.INDEX_FILE);
    const spliced = ArtifactEmitter.spliceIslands(readFileSync(indexPath, "utf8"), islands);
    if (spliced === null) {
      return { kind: "no-head" };
    }
    writeFileSync(indexPath, spliced);
    return { kind: "ok", indexPath, islandNames: Object.keys(islands) };
  }
}
