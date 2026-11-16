import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import type { Locale } from "@/i18n/config";
import { messagesFor } from "@/i18n/messages";
import { FeedItem } from "./feed-item";

function renderItem(locale: Locale, premium?: "sd" | "hd" | "fhd" | null) {
  render(
    <NextIntlClientProvider locale={locale} messages={{ feed: messagesFor(locale).feed }}>
      <FeedItem
        index={0}
        title="Chiều Hà Nội"
        authorId="0192f0c1-7a3e-7c4b-9d2e-000000000002"
        author={null}
        authorHref={null}
        publishedAgo={null}
        posterUrl={null}
        current
        playback="playing"
        pausedByUser={false}
        muted
        showUnmuteHint={false}
        liked={false}
        likeCount={null}
        viewCount={null}
        follow={null}
        locked={false}
        onLike={() => {}}
        onShare={() => {}}
        onStageTap={() => {}}
        onToggleMute={() => {}}
        onRetry={() => {}}
        premium={premium}
      />
    </NextIntlClientProvider>,
  );
}

describe("FeedItem premium label", () => {
  it.each<[Locale, "sd" | "hd" | "fhd" | null, string]>([
    ["vi", null, "Premium · Xem thử"],
    ["en", null, "Premium · Preview"],
    ["vi", "sd", "Premium · SD"],
    ["en", "hd", "Premium · HD"],
    ["vi", "fhd", "Premium · Full HD"],
  ])("%s, tier %s: reads %j", (locale, tier, label) => {
    renderItem(locale, tier);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it("is absent on an ordinary video", () => {
    renderItem("vi");
    expect(screen.queryByText(/Premium/)).toBeNull();
  });
});
