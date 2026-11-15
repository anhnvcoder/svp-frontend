import { Lock, LockOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Tier } from "@/features/feed/api";
import { cn } from "@/lib/cn";

type PremiumBadgeProps = {
  // The tier the viewer plays the full video with; null while the public preview plays.
  tier: Tier | null;
  // "media" over the video, "surface" on the page's own background.
  tone: "media" | "surface";
  className?: string;
};

// The label of a premium video: closed while its preview plays, open with the tier once the full video plays.
export function PremiumBadge({ tier, tone, className }: PremiumBadgeProps) {
  const t = useTranslations("feed.premium");
  const Icon = tier === null ? Lock : LockOpen;
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] leading-none font-semibold",
        tone === "media" ? "bg-[oklch(0_0_0/0.4)] text-on-media" : "bg-accent/20 text-accent-text",
        className,
      )}
    >
      <Icon aria-hidden="true" size={14} />
      {t("label")} · {tier === null ? t("preview") : t(`tier.${tier}`)}
    </span>
  );
}
