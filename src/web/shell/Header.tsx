import { useState } from "react";
import { IconButton } from "../components/IconButton";
import { refreshPage, useActive } from "../api/queries";
import { NAV_LINKS, SECTION_HREF } from "../router/route";
import type { Route } from "../router/route";
import { BuildBanner } from "./BuildBanner";
import { ActivePill } from "./ActivePill";
import { HealthPill } from "../runs/RunHealth";
import { HerdrChip } from "./HerdrChip";
import { useHealthSummary } from "../runs/queries";
import { Freshness } from "./Freshness";
import { useTheme } from "./theme";

const TITLES: Record<Route["kind"], string> = Object.fromEntries(
  Object.entries(SECTION_HREF).map(([kind, href]) => [kind, NAV_LINKS.find((l) => l.href === href)?.label ?? ""]),
) as Record<Route["kind"], string>;

const REFRESH_LABEL = "Refresh this page";

/** Top bar: section title, active-items pill, freshness, refresh and theme. Navigation lives in the rail and tab bar. */
export function Header({ route }: { route: Route }) {
  const active = useActive();
  const healthSummary = useHealthSummary();
  const { theme, toggle } = useTheme();
  const [refreshing, setRefreshing] = useState(false);
  return (
    <header className="topbar">
      <h1 className="topbar-title">{TITLES[route.kind]}</h1>
      <div className="spacer" />
      <BuildBanner />
      <ActivePill items={active.data?.items ?? []} />
      <HealthPill summary={healthSummary} />
      <HerdrChip health={healthSummary?.herdr} />
      <Freshness />
      <IconButton
        id="refresh"
        label={REFRESH_LABEL}
        spinning={refreshing}
        disabled={refreshing}
        onClick={() => {
          setRefreshing(true);
          void refreshPage(route.kind).finally(() => {
            setRefreshing(false);
          });
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 11a8 8 0 0 0-14.9-3M4 5v4h4" />
          <path d="M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4" />
        </svg>
      </IconButton>
      <IconButton id="theme" label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={toggle}>
        {theme === "dark" ? (
          <svg className="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4" />
          </svg>
        ) : (
          <svg className="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
          </svg>
        )}
      </IconButton>
    </header>
  );
}
