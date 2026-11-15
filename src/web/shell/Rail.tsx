import { NAV_LINKS } from "../router/route";
import { NavIcon } from "./NavIcons";

export function Rail({ current, collapsed, onToggle }: { current: string; collapsed: boolean; onToggle: () => void }) {
  return (
    <aside className="rail">
      <div className="rail-brand">
        <a href="#/" aria-label="orch home">
          <svg className="brand-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
            <path d="M12 8.8V4M9.2 13.6 5 16M14.8 13.6 19 16" />
            <circle cx="12" cy="3.5" r="1.6" />
            <circle cx="4.2" cy="16.6" r="1.6" />
            <circle cx="19.8" cy="16.6" r="1.6" />
          </svg>
          <span className="rail-label">orch</span>
        </a>
      </div>
      <nav className="rail-nav" aria-label="Sections">
        {NAV_LINKS.map((link) => (
          <a key={link.href} href={link.href} title={link.label} aria-current={link.href === current ? "page" : undefined}>
            <NavIcon href={link.href} />
            <span className="rail-label">{link.label}</span>
          </a>
        ))}
      </nav>
      <button type="button" className="rail-toggle" aria-expanded={!collapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={onToggle}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={collapsed ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6"} />
        </svg>
        <span className="rail-label">Collapse</span>
      </button>
    </aside>
  );
}

export function TabBar({ current }: { current: string }) {
  return (
    <nav className="tabbar" aria-label="Sections (mobile)">
      {NAV_LINKS.map((link) => (
        <a key={link.href} href={link.href} aria-current={link.href === current ? "page" : undefined}>
          <NavIcon href={link.href} />
          <span>{link.label}</span>
        </a>
      ))}
    </nav>
  );
}
