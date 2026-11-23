import type { ReactNode } from "react";

const PATHS: Record<string, ReactNode> = {
  "#/": <path d="M5 4v16l14-8z" />,
  "#/chats": <path d="M4 5h16v11H9l-5 4z" />,
  "#/profiles": (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-4 3-6 7-6s7 2 7 6" />
    </>
  ),
  "#/harnesses": (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 10l-2 2 2 2M15 10l2 2-2 2" />
    </>
  ),
  "#/schedules": (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  "#/memory": (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3 3 7 3s7-1.3 7-3v-6" />
    </>
  ),
  "#/suggestions": <path d="M12 3a6 6 0 0 0-3 11v3h6v-3a6 6 0 0 0-3-11zM10 20h4" />,
  "#/how": (
    <>
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M7 6h10M6.4 7.6 10.6 16.4M17.6 7.6 13.4 16.4" />
    </>
  ),
  "#/feedback": (
    <>
      <rect x="6" y="4" width="12" height="17" rx="2" />
      <path d="M9 3h6v3H9zM9.5 13l2 2 3.5-4" />
    </>
  ),
};

export function NavIcon({ href }: { href: string }) {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[href]}
    </svg>
  );
}
