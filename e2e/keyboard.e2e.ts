import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { authedTest, expect, feedItem, playingVideo, testClip } from "./fixtures";
import { seed } from "./seed";

// The feed and the upload flow with the keyboard alone (WCAG 2.1.1 Keyboard, 2.4.7 Focus Visible): every step is a key
// press, nothing is clicked or tapped, and each control reached shows that it has the focus.

// The key that moves the focus to the next control. WebKit on macOS, like Safari, moves Tab between text fields only
// unless the user turned on "Press Tab to highlight each item"; Option-Tab reaches every control there. Elsewhere
// (Chromium, WebKitGTK on CI's Linux runner) Tab reaches every control.
function nextKey(browserName: string): string {
  return browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
}

// Presses the next-control key until `target` has the focus, at most `limit` times; fails when it never gets it.
async function tabTo(page: Page, browserName: string, target: Locator, limit = 40): Promise<void> {
  const key = nextKey(browserName);
  for (let presses = 0; presses < limit; presses++) {
    await page.keyboard.press(key);
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
  }
  throw new Error(`${target} not reached in ${limit} presses of ${key}`);
}

// The control has the focus, matches :focus-visible and draws something for it: the design's ring (a box-shadow,
// components/ui/styles.ts) or an outline.
async function expectFocusVisible(target: Locator): Promise<void> {
  await expect(target).toBeFocused();
  const shown = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      drawn: style.boxShadow !== "none" || (style.outlineStyle !== "none" && style.outlineWidth !== "0px"),
    };
  });
  expect(shown).toEqual({ focusVisible: true, drawn: true });
}

authedTest(
  "feed with the keyboard: Tab to the playing video and the action rail, like and unlike, next video",
  async ({ page, browserName }) => {
    const { xss } = seed();
    await page.goto("/");
    const first = feedItem(page, 0);
    await expect(first).toHaveAttribute("aria-label", xss.title);
    await expect(playingVideo(first)).toHaveCount(1);

    // The control over the playing video pauses it.
    const stage = first.getByRole("button", { name: "Pause video" });
    await tabTo(page, browserName, stage);
    await expectFocusVisible(stage);

    // The action rail: follow the author, like, share; the seeded author is not the session's user.
    const follow = first.getByRole("button", { name: "Follow creator" });
    await tabTo(page, browserName, follow);
    await expectFocusVisible(follow);

    const like = first.getByRole("button", { name: /^Like video/ });
    await tabTo(page, browserName, like);
    await expectFocusVisible(like);
    await expect(like).toHaveAttribute("aria-pressed", "false");
    const likeSaved = (method: string) =>
      page.waitForResponse(
        (response) =>
          response.request().method() === method && new URL(response.url()).pathname.endsWith(`/${xss.video_id}/like`),
      );
    let saved = likeSaved("PUT");
    await page.keyboard.press("Enter");
    await expect(like).toHaveAttribute("aria-pressed", "true");
    expect((await saved).ok()).toBe(true);
    await expectFocusVisible(like);
    // Space on the button presses the button: it is not the feed's pause shortcut. The session's user ends unliked,
    // as the other tests sharing it expect.
    saved = likeSaved("DELETE");
    await page.keyboard.press(" ");
    await expect(like).toHaveAttribute("aria-pressed", "false");
    expect((await saved).ok()).toBe(true);
    await expect(playingVideo(first)).toHaveCount(1);

    const share = first.getByRole("button", { name: "Copy share link" });
    await tabTo(page, browserName, share);
    await expectFocusVisible(share);

    // Arrow Down moves to the next video, which plays on screen, and Arrow Up back to the first.
    await page.keyboard.press("ArrowDown");
    const second = feedItem(page, 1);
    await expect(playingVideo(second)).toHaveCount(1);
    await expect(second).toBeInViewport({ ratio: 0.6 });
    const secondLike = second.getByRole("button", { name: /^Like video/ });
    await tabTo(page, browserName, secondLike);
    await expectFocusVisible(secondLike);
    await page.keyboard.press("ArrowUp");
    await expect(playingVideo(first)).toHaveCount(1);
    await expect(first).toBeInViewport({ ratio: 0.6 });
  },
);

// Tagged @publishes: the video gets READY and leads Explore, so it runs after the other tests (playwright.config.ts).
authedTest(
  "upload with the keyboard: open the file picker, give a title, post with Enter",
  { tag: "@publishes" },
  async ({ page, browserName }) => {
    authedTest.setTimeout(300_000);
    const clip = testClip(4, "360x640");
    await page.goto("/upload");
    await expect(page.getByRole("heading", { level: 1, name: "Upload a video" })).toBeVisible();

    // The button opens the browser's file picker, which the test answers with the clip.
    const choose = page.getByRole("button", { name: "Choose file" });
    await tabTo(page, browserName, choose);
    await expectFocusVisible(choose);
    const picker = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    await (await picker).setFiles(clip);
    await expect(page.getByText(basename(clip))).toBeVisible();

    const titleField = page.getByLabel("Title");
    await tabTo(page, browserName, titleField);
    await expectFocusVisible(titleField);
    const title = `e2e keyboard ${randomBytes(4).toString("hex")}`;
    await page.keyboard.type(title);
    await expect(titleField).toHaveValue(title);

    const post = page.getByRole("button", { name: "Post video" });
    await tabTo(page, browserName, post);
    await expectFocusVisible(post);
    await page.keyboard.press("Enter");
    await expect(page.getByText("Processing the video")).toBeVisible();
    await expect(page.getByText("Your video is ready")).toBeVisible({ timeout: 240_000 });

    const watch = page.getByRole("link", { name: "Watch video" });
    await tabTo(page, browserName, watch);
    await expectFocusVisible(watch);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(playingVideo(page.locator("article"))).toHaveCount(1);
  },
);
