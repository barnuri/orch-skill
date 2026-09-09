export interface ServeArgs {
  home: string;
  host: string;
  port: number;
  harnesses: readonly string[];
  outcomes: readonly string[];
}
