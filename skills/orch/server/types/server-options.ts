export interface ServerOptions {
  home: string;
  host: string;
  port: number;
  tokenDigest: Uint8Array;
  /** When true, even loopback requests must present the bearer token. */
  requireToken: boolean;
  harnesses: readonly string[];
  outcomes: readonly string[];
}
