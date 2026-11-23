// Integration lane: the real server in the compose stack, on the seeded temp home.
// UI navigation waits for `commit`, not `load`: the app holds a live SSE feed, so `load` never settles.
import { expect, test } from "@playwright/test";

const RUN_TITLE = "Lane run";
const RUN_ID = "lane-run";

test("API lists the seeded run", async ({ request }) => {
  const res = await request.get("/api/runs");
  expect(res.status(), await res.text()).toBe(200);
  expect(await res.text()).toContain(RUN_ID);
});

test("health reports the lane home, not the live home", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain("/orch-home");
  expect(body).not.toContain(".harness-orch");
});

test("runs page shows the seeded run", async ({ page }) => {
  await page.goto("/", { waitUntil: "commit" });
  await expect(page.getByText(RUN_TITLE).first()).toBeVisible();
});

test("run detail opens for the seeded run", async ({ page }) => {
  await page.goto("/", { waitUntil: "commit" });
  await page.getByText(RUN_TITLE).first().click();
  await expect(page).toHaveURL(new RegExp(RUN_ID));
  await expect(page.getByText(RUN_TITLE).first()).toBeVisible();
});
