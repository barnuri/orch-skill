// One-time generator: renders the orch mark (src/snapshot/favicon.svg) to the PNG icons the two installable apps need.
// Run `bun scripts/gen-pwa-icons.ts` and commit src/web/pwa/static/icons/*.png. @resvg/resvg-js is a devDependency only for this.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const OUT = join(import.meta.dir, "../src/web/pwa/static/icons");
// Token values (src/snapshot/tokens.css, dark side): --bg and --acc. The chat app swaps them, so the two icons differ at a glance.
const BG = "#0b0d10";
const ACC = "#3d8bfd";
const APPS = { dashboard: { bg: BG, mark: ACC }, chat: { bg: ACC, mark: BG } } as const;

const MARK = (c: string): string =>
  `<g fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3.2" fill="${c}" stroke="none"/><path d="M12 8.8V4M9.2 13.6 5 16M14.8 13.6 19 16"/><circle cx="12" cy="3.5" r="1.6"/><circle cx="4.2" cy="16.6" r="1.6"/><circle cx="19.8" cy="16.6" r="1.6"/></g>`;

/** `scale` is the mark's size as a share of the canvas; `radius` rounds the background (0 = full bleed for maskable and apple-touch). */
function svg(bg: string | null, mark: string, size: number, scale: number, radius: number): string {
  const k = (size * scale) / 24;
  const tx = size / 2 - 12 * k;
  const ty = size / 2 - 10.05 * k;
  const rect = bg === null ? "" : `<rect width="${size}" height="${size}" rx="${size * radius}" fill="${bg}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${rect}<g transform="translate(${tx} ${ty}) scale(${k})">${MARK(mark)}</g></svg>`;
}

function write(name: string, source: string, size: number): void {
  writeFileSync(join(OUT, name), new Resvg(source, { fitTo: { mode: "width", value: size } }).render().asPng());
}

mkdirSync(OUT, { recursive: true });
for (const [app, c] of Object.entries(APPS)) {
  write(`${app}-192.png`, svg(c.bg, c.mark, 192, 0.7, 0.22), 192);
  write(`${app}-512.png`, svg(c.bg, c.mark, 512, 0.7, 0.22), 512);
  write(`${app}-maskable-512.png`, svg(c.bg, c.mark, 512, 0.5, 0), 512);
  write(`${app}-apple-touch-180.png`, svg(c.bg, c.mark, 180, 0.62, 0), 180);
  write(`${app}-favicon-32.png`, svg(c.bg, c.mark, 32, 0.76, 0.22), 32);
  write(`${app}-favicon-48.png`, svg(c.bg, c.mark, 48, 0.76, 0.22), 48);
}
// Android status-bar badge: white mark on transparent, the only colour the OS keeps.
write("badge-96.png", svg(null, "#ffffff", 96, 0.9, 0), 96);
console.log(`wrote icons to ${OUT}`);
