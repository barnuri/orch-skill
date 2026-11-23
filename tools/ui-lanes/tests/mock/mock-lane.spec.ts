// Fast mock lane. Every request must stay on the mock dev server origin; nothing reaches port 6724.
// Navigation waits for `commit`: the app holds a live feed open, so `load` does not settle.
import { expect, test, type Page } from "@playwright/test";

const RUN_ID = "20261120-090000-a1b2";
const RUN_TITLE = "Fixture: mock running run";

function trackOrigins(page: Page): string[] {
  const origins: string[] = [];
  page.on("request", (r) => origins.push(new URL(r.url()).origin));
  return origins;
}

test("runs page renders the deterministic fixture run", async ({ page }) => {
  const origins = trackOrigins(page);
  await page.goto("/", { waitUntil: "commit" });
  await expect(page.getByText(RUN_TITLE)).toBeVisible();
  await expect(page.getByText(RUN_ID)).toBeVisible();
  await expect(page.locator('[title="1 of 3 nodes done"]').first()).toHaveText("1/3 done");
  expect(origins.every((o) => o === new URL(page.url()).origin), origins.join("\n")).toBe(true);
});

test("run detail renders the fixture nodes", async ({ page }) => {
  await page.goto("/", { waitUntil: "commit" });
  await page.getByText(RUN_TITLE).click();
  await expect(page).toHaveURL(new RegExp(RUN_ID));
  await expect(page.getByText("Plan the change").first()).toBeVisible();
});

test("two loads render the same text", async ({ page }) => {
  await page.goto("/", { waitUntil: "commit" });
  await expect(page.getByText(RUN_TITLE)).toBeVisible();
  const first = await page.locator("main, body").first().innerText();
  await page.reload({ waitUntil: "commit" });
  await expect(page.getByText(RUN_TITLE)).toBeVisible();
  const second = await page.locator("main, body").first().innerText();
  expect(second.replace(/\d+\s*(s|m|h|d) ago/g, "")).toBe(first.replace(/\d+\s*(s|m|h|d) ago/g, ""));
});
