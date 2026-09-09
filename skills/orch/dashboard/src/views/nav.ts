import type { Route } from "../router";

const NAV_LINKS: string = "nav.nav a";
const CURRENT_ATTR: string = "aria-current";

// The run view belongs to the Runs section, so `#/run/<id>` highlights `#/`.
const SECTION_HREF: Record<Route["kind"], string> = {
  list: "#/",
  run: "#/",
  profiles: "#/profiles",
  memory: "#/memory",
};

export function renderNav(route: Route): void {
  const current = SECTION_HREF[route.kind];
  for (const link of document.querySelectorAll<HTMLAnchorElement>(NAV_LINKS)) {
    if (link.getAttribute("href") === current) {
      link.setAttribute(CURRENT_ATTR, "page");
    } else {
      link.removeAttribute(CURRENT_ATTR);
    }
  }
}
