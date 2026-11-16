import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Rail } from "./Rail";

test("the Chats item has an icon link that opens the chat-only page in a new tab", () => {
  (globalThis as { location?: { origin: string } }).location = { origin: "http://x.test" };
  const html = renderToStaticMarkup(<Rail current="#/" collapsed={false} onToggle={() => undefined} />);
  expect(html).toContain('href="http://x.test/chat"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('aria-label="Open chat-only in a new tab"');
  expect(html.match(/rail-open/g)?.length).toBe(1);
});
