import { Suspense, lazy, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useRoute } from "../router/use-route";
import { RunPage } from "../runs/RunPage";
import { RunsPage } from "../runs/RunsPage";
import { HarnessesPage } from "../pages/HarnessesPage";
import { MemoryPage } from "../pages/MemoryPage";
import { ProfilesPage } from "../pages/ProfilesPage";
import { SchedulesPage } from "../pages/SchedulesPage";
import { SuggestionsPage } from "../pages/SuggestionsPage";
import type { Route } from "../router/route";
import { SECTION_HREF } from "../router/route";
import { Header } from "./Header";
import { Rail, TabBar } from "./Rail";
import { TokenGate } from "./TokenGate";
import { useAuthRequired } from "./use-connection";

const ChatsPage = lazy(() => import("../chats/ChatsPage").then((m) => ({ default: m.ChatsPage })));

const RAIL_KEY = "orch-rail";
const TITLE_PREFIX = "orch — ";

function sectionTitle(route: Route): string {
  return route.kind === "list" ? "runs" : route.kind === "run" ? route.runId : route.kind;
}

function Page({ route }: { route: Route }): ReactNode {
  switch (route.kind) {
    case "chats":
      return <ChatsPage chatId={route.chatId} projectId={route.projectId ?? null} />;
    case "project":
      return <ChatsPage chatId={null} projectId={route.projectId} />;
    case "profiles":
      return <ProfilesPage />;
    case "harnesses":
      return <HarnessesPage />;
    case "schedules":
      return <SchedulesPage />;
    case "memory":
      return <MemoryPage />;
    case "suggestions":
      return <SuggestionsPage />;
    case "list":
      return <RunsPage />;
    case "run":
      return <RunPage runId={route.runId} />;
  }
}

export function AppShell() {
  const route = useRoute();
  const authRequired = useAuthRequired();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(RAIL_KEY) === "collapsed";
    } catch {
      return false;
    }
  });
  const toggleRail = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(RAIL_KEY, c ? "open" : "collapsed");
      } catch {
        /* storage blocked: the choice lasts for this page */
      }
      return !c;
    });
  };
  const current = SECTION_HREF[route.kind];
  useEffect(() => {
    const header = document.querySelector("header");
    if (header === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const set = (): void => {
      document.documentElement.style.setProperty("--hdr", `${header.getBoundingClientRect().height}px`);
    };
    set();
    const watcher = new ResizeObserver(set);
    watcher.observe(header);
    return () => {
      watcher.disconnect();
      document.documentElement.style.removeProperty("--hdr");
    };
  }, []);
  useEffect(() => {
    document.title = `${TITLE_PREFIX}${sectionTitle(route)}`;
  }, [route]);
  return (
    <div className="shell" data-rail={collapsed ? "collapsed" : "open"}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Rail current={current} collapsed={collapsed} onToggle={toggleRail} />
      <div className="shell-main">
        <Header route={route} />
        <main id="main" tabIndex={-1}>
          {authRequired ? <TokenGate /> : <Suspense fallback={null}><Page route={route} /></Suspense>}
        </main>
      </div>
      <TabBar current={current} />
    </div>
  );
}
