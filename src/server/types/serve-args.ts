export interface ServeArgs {
  home: string;
  host: string;
  port: number;
  requireToken: boolean;
  /** When false, non-loopback peers need no bearer token. Defaults to true. */
  requireRemoteToken: boolean;
  harnesses: readonly string[];
  outcomes: readonly string[];
}
