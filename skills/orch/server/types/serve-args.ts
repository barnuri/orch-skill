export interface ServeArgs {
  home: string;
  host: string;
  port: number;
  requireToken: boolean;
  harnesses: readonly string[];
  outcomes: readonly string[];
}
