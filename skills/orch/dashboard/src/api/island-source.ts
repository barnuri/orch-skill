import type { ApiResult } from "./api-result";
import { hasDataIslands, readDataIsland } from "./data-island";
import type { IslandHost } from "./island-host";

/**
 * Reads API documents out of the page's embedded islands instead of the network, so an emitted
 * artifact renders with no server behind it. A source with no host — or a page carrying no
 * islands — is inactive, and every read returns null so `ApiClient` falls through to `fetch`.
 */
export class IslandSource {
  /** Documents the emitter always writes; any one of them present means this page is a snapshot. */
  private static readonly PROBE_NAMES: readonly string[] = ["runs", "profiles", "memory", "suggestions"];
  private static readonly READ_ONLY_STATUS: number = 405;
  private static readonly READ_ONLY_MESSAGE: string =
    "This is a published snapshot — it has no server to save to.";

  private readonly host: IslandHost | null;
  private readonly islandsPresent: boolean;

  constructor(host: IslandHost | null) {
    this.host = host;
    this.islandsPresent = host !== null && hasDataIslands(IslandSource.PROBE_NAMES, host);
  }

  /** Binds to the real document when there is one; `bun test` and the server have none. */
  static fromDocument(): IslandSource {
    return new IslandSource(typeof document === "undefined" ? null : document);
  }

  get active(): boolean {
    return this.islandsPresent;
  }

  /** The named document when this page embeds it, else null meaning "not here, go fetch". */
  read<T>(name: string): ApiResult<T> | null {
    if (this.host === null) {
      return null;
    }
    const body = readDataIsland<T>(name, this.host);
    if (body === null) {
      return null;
    }
    return { kind: "ok", body, etag: null };
  }

  /** The answer a write gets in a snapshot: an error the existing error paths already render. */
  readOnlyRefusal<T>(): ApiResult<T> {
    return {
      kind: "error",
      status: IslandSource.READ_ONLY_STATUS,
      body: { error: IslandSource.READ_ONLY_MESSAGE },
    };
  }
}
