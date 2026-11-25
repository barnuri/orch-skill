// Headed proof of the run UI: opens the runs page and a run detail in a visible browser and saves
// screenshots plus a manifest. The config records video and trace for the same session.
import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";

const RUN_ID = "20261120-090000-a1b2";
const RUN_TITLE = "Fixture: mock running run";

test("headed proof: runs page and run detail", async ({ page, browser }, info) => {
  expect(info.project.use.headless, "proof lane must run headed").toBe(false);
  const origins = new Set<string>();
  page.on("request", (r) => origins.add(new URL(r.url()).origin));

  await page.goto("/", { waitUntil: "commit" });
  await expect(page.getByText(RUN_TITLE)).toBeVisible();
  await expect(page.locator('[title="1 of 3 nodes done"]').first()).toHaveText("1/3 done");
  const runsShot = info.outputPath("01-runs-page.png");
  await page.screenshot({ path: runsShot, fullPage: true });

  await page.getByText(RUN_TITLE).click();
  await expect(page).toHaveURL(new RegExp(RUN_ID));
  await expect(page.getByText("Plan the change").first()).toBeVisible();
  const detailShot = info.outputPath("02-run-detail.png");
  await page.screenshot({ path: detailShot, fullPage: true });

  const pageOrigin = new URL(page.url()).origin;
  expect([...origins].every((o) => o === pageOrigin), [...origins].join("\n")).toBe(true);
  writeFileSync(
    info.outputPath("proof.json"),
    JSON.stringify(
      {
        headless: info.project.use.headless,
        browser: browser.browserType().name(),
        browserVersion: browser.version(),
        url: page.url(),
        runId: RUN_ID,
        origins: [...origins],
        screenshots: [runsShot, detailShot],
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
});
