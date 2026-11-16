// The manifest link is added here, not in the html: Bun's html bundler cannot leave an absolute server route like
// /chat/manifest.webmanifest alone (it tries to resolve it as a file). Browsers evaluate installability when the link appears.
export const manifestHref = (pathname: string): string => (pathname === "/chat" || pathname.startsWith("/chat/") ? "/chat/manifest.webmanifest" : "/manifest.webmanifest");

export function ensureManifestLink(doc: Document, pathname: string): HTMLLinkElement {
  const existing = doc.head.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (existing !== null) return existing;
  const link = doc.createElement("link");
  link.rel = "manifest";
  link.href = manifestHref(pathname);
  doc.head.appendChild(link);
  return link;
}

if (typeof document !== "undefined" && typeof location !== "undefined") ensureManifestLink(document, location.pathname);
