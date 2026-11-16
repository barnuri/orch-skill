import type { TlsRuntime } from "../tls/manager";

export interface ServerOptions {
  home: string;
  host: string;
  port: number;
  tokenDigest: Uint8Array;
  /** When true, even loopback requests must present the bearer token. */
  requireToken: boolean;
  /** When false, non-loopback peers need no bearer token. */
  requireRemoteToken: boolean;
  harnesses: readonly string[];
  outcomes: readonly string[];
  /** Present only when the opt-in HTTPS listener is configured. */
  tls?: TlsRuntime;
  /** The HTTPS port, 0 when off. Only informs /api/server-info; no link is built from it automatically. */
  httpsPort?: number;
  /** Whether the quiet secure-link hint may show. */
  secureLinkHint?: boolean;
}
