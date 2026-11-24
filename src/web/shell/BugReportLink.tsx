import repoPackage from "../../../package.json";
import { bugReportUrl, repoUrl, type RepoMeta } from "./bug-report";

/** Opens the repo's issues in a new tab, or the repo homepage when no issues URL resolves. Renders nothing when no URL resolves. */
export function BugReportLink({ meta = repoPackage }: { meta?: RepoMeta }) {
  const href = bugReportUrl(meta);
  if (href === null) return null;
  return (
    <a
      className="icon-btn bug-report"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Open the issues in a new tab"
      title="Issues"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m8 2 1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
        <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9" />
        <path d="M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4" />
      </svg>
    </a>
  );
}

/** Opens the GitHub repo in a new tab. Renders nothing when no repository URL resolves. */
export function RepoLink({ meta = repoPackage }: { meta?: RepoMeta }) {
  const href = repoUrl(meta);
  if (href === null) return null;
  return (
    <a
      className="icon-btn bug-report"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Open the GitHub repo in a new tab"
      title="GitHub repo"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
        <path d="M9 18c-4.51 2-5-2-7-2" />
      </svg>
    </a>
  );
}
