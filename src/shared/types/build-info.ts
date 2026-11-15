export interface BuildCommit {
  sha: string;
  subject: string;
  date: string;
}

export interface BuildInfo {
  boot_at: string;
  boot_head: string | null;
  head: string | null;
  branch: string | null;
  stale: boolean;
  reasons: ("commits" | "files")[];
  missing_commits: BuildCommit[];
  missing_total: number;
  changed_files: { count: number; newest: { path: string; mtime: string }[] };
  uncommitted: { count: number };
  busy: { chats_streaming: number; runs_running: number };
  error: string | null;
}

export interface RestartRefused {
  error: string;
  command: string;
}
