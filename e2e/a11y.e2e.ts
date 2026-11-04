import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { authedTest, expect, feedItem, generatedHandle, playingVideo, test } from "./fixtures";
import { seed } from "./seed";

// axe on the screens of the web client: no violation of WCAG 2.2 level A or AA, whatever its impact (axe's rules
// tagged for WCAG 2.0, 2.1 and 2.2 A and AA; its best-practice rules outside those tags are not checked here).
// The cspViolations fixture fails each test on any CSP violation as well, so these pages are also the
// "no CSP violation" check of login, register, the feed while a video plays, upload, the profiles and the share page.

const wcag22aa = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

async function expectNoViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(wcag22aa).analyze();
  const found = violations.map(
    (violation) =>
      `${violation.impact} ${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(" ")).join(", ")})`,
  );
  expect(found).toEqual([]);
}

for (const path of ["/login", "/register"]) {
  test(`${path}: no WCAG 2.2 AA violation, no CSP violation`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoViolations(page);
  });
}

authedTest("feed while a video plays: no WCAG 2.2 AA violation, no CSP violation", async ({ page }) => {
  await page.goto("/");
  await expect(playingVideo(feedItem(page, 0))).toHaveCount(1);
  await expectNoViolations(page);
});

authedTest("/upload, /me and /u/{handle}: no WCAG 2.2 AA violation, no CSP violation", async ({ page }) => {
  await page.goto("/upload");
  await expect(page.getByRole("button", { name: "Choose file" })).toBeVisible();
  await expectNoViolations(page);

  await page.goto("/me");
  await expect(page.getByRole("heading", { level: 1 })).toBeAttached();
  await page.waitForLoadState("networkidle");
  await expectNoViolations(page);

  const { xss } = seed();
  await page.goto(`/u/${generatedHandle(xss.author_id)}`);
  await expect(page.getByRole("button", { name: /^Follow/ })).toBeVisible();
  await expectNoViolations(page);
});

test("/v/{id} for a guest while the video plays: no WCAG 2.2 AA violation, no CSP violation", async ({ page }) => {
  const { xss } = seed();
  await page.goto(`/v/${xss.video_id}`);
  await expect(playingVideo(page.locator("article"))).toHaveCount(1);
  await expectNoViolations(page);
});
