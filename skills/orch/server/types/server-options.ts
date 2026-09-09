export interface ServerOptions {
  home: string;
  host: string;
  port: number;
  tokenDigest: Uint8Array;
  harnesses: readonly string[];
  outcomes: readonly string[];
}
