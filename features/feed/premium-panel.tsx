"use client";

import { Lock, LockOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { useCountdown } from "@/components/shell/use-countdown";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { tiers, type Tier } from "./api";
import { initialPurchaseState, type PurchaseState } from "./purchase";

type PremiumPanelProps = {
  videoId: string;
  // The tier the viewer holds, null when they hold none (a guest holds none).
  tier: Tier | null;
  // A guest is asked to log in; the author holds every tier and buys nothing.
  viewer: "guest" | "author" | "user";
  // purchaseTierAction of server/entitlement-actions.ts.
  action: (previous: PurchaseState, form: FormData) => Promise<PurchaseState>;
  onLogIn: () => void;
  className?: string;
};

// What a premium video offers on its page: the preview and a way to the whole video. A logged-in viewer picks a tier,
// bought (simulated, nothing is charged) by a Server Action, so the form also works without JavaScript; the action
// renders the page again, which then plays the whole video. The tier held can be changed, up or down.
export function PremiumPanel({ videoId, tier, viewer, action, onLogIn, className }: PremiumPanelProps) {
  const t = useTranslations("share.premium");
  const f = useTranslations("feed.premium");
  const [state, formAction, pending] = useActionState(action, initialPurchaseState);
  const rateLimited = state.error === "RATE_LIMITED";
  const locked = useCountdown(rateLimited ? state.retryAfterSeconds : null, state) > 0;
  const Icon = tier === null ? Lock : LockOpen;
  const titleId = useId();

  let body;
  if (viewer === "guest") {
    body = t("guestBody");
  } else if (viewer === "author") {
    body = t("authorBody");
  } else {
    body = tier === null ? t("previewBody") : t("heldBody", { tier: f(`tier.${tier}`) });
  }

  return (
    <section
      aria-labelledby={titleId}
      className={cn("flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4 md:p-5", className)}
    >
      <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold">
        <Icon aria-hidden="true" size={18} className="text-accent-text" />
        {t("title")}
      </h2>
      <p className="text-sm leading-normal text-muted">{body}</p>
      {viewer === "guest" && (
        <Button variant="primary" onClick={onLogIn}>
          {t("logIn")}
        </Button>
      )}
      {viewer === "user" && (
        <form action={formAction} className="flex flex-col gap-2.5">
          <input type="hidden" name="video_id" value={videoId} />
          <div role="group" aria-label={t("tiersLabel")} className="flex flex-wrap gap-2">
            {tiers.map((option) => {
              const label = f(`tier.${option}`);
              const held = option === tier;
              return (
                <Button
                  key={option}
                  type="submit"
                  name="tier"
                  value={option}
                  variant={held ? "secondary" : "primary"}
                  disabled={held || pending || locked}
                  aria-label={held ? t("held", { tier: label }) : t("buy", { tier: label })}
                  className="flex-1"
                >
                  {label}
                </Button>
              );
            })}
          </div>
          <p className="text-xs text-muted">{t("simulated")}</p>
          {state.error && (
            <p role="alert" className="text-sm text-danger">
              {rateLimited ? t("rateLimited") : t("failed")}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
