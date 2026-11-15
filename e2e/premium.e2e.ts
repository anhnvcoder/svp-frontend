import { randomBytes } from "node:crypto";
import { expect, gatewayToken, logIn, playingVideo, publishVideo, registerAccount, test, testClip } from "./fixtures";

// A premium video on its page /v/{id}: the public preview with its label, a simulated purchase of a tier through the
// Server Action, then the whole video played through the web server's /api, its segments signed for the tier.

// Tagged @publishes: the premium video gets READY and leads Explore, so it runs after the other tests
// (playwright.config.ts).
test(
  "a premium video plays its preview, then the whole video once SD is bought",
  { tag: "@publishes" },
  async ({ page }) => {
    test.slow();
    const author = await registerAccount();
    const title = `e2e premium ${randomBytes(4).toString("hex")}`;
    // Three 4 s segments: the preview takes the first, so a premium video needs at least two. A short side of 720
    // gives the ladder a 720p rendition, which the SD master below must leave out.
    const videoId = await publishVideo(await gatewayToken(author), title, testClip(12, "720x1280"), true);

    const viewer = await registerAccount();
    const pagePath = `/v/${videoId}`;
    await logIn(page, viewer, `/login?next=${encodeURIComponent(pagePath)}`);
    await expect(page).toHaveURL(pagePath);
    const stage = page.getByRole("article");
    await expect(page.getByText("Premium · Preview").filter({ visible: true }).first()).toBeVisible();
    await expect(playingVideo(stage)).toHaveCount(1, { timeout: 30_000 });

    // The whole video: the master playlist of the tier and a signed segment under premium/.
    const master = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/api/videos/${videoId}/playback/master.m3u8`,
    );
    const segment = page.waitForResponse(
      (response) => response.url().includes(`/premium/${videoId}/`) && response.request().method() === "GET",
      { timeout: 60_000 },
    );
    await page.getByRole("button", { name: "Buy SD (simulated)" }).filter({ visible: true }).click();

    const masterResponse = await master;
    expect(masterResponse.status()).toBe(200);
    expect(masterResponse.headers()["content-type"]).toContain("application/vnd.apple.mpegurl");
    // SD holds no rendition above 360p.
    expect(await masterResponse.text()).not.toContain("720p");
    expect((await segment).status()).toBe(200);

    await expect(page.getByText("Premium · SD").filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "SD · current" }).filter({ visible: true })).toBeDisabled();
    await expect(playingVideo(stage)).toHaveCount(1, { timeout: 30_000 });
  },
);
