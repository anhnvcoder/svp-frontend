"use server";

import { refresh } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isTier } from "@/features/feed/api";
import { initialPurchaseState, type PurchaseState } from "@/features/feed/purchase";
import { serverEnv } from "./env";
import { clientAddressOf, gatewayClient, retryAfterSeconds } from "./gateway";
import { bffServices } from "./runtime";
import { sessionCookieName } from "./session";
import { isVideoId } from "./video-page";

// Server Action of the tier buttons of a premium video on /v/{id}, for useActionState; a form posted without
// JavaScript works the same. Nothing is charged: PUT /me/entitlements/{video_id} records the tier. It is a public
// endpoint like every action: it checks its own input and the session itself, and the session's token stays here.

// Above the gateway's own 3 s per backend call, so the gateway's 504 arrives before this gives up.
const purchaseTimeoutMs = 4000;

const failed: PurchaseState = { error: "FAILED", retryAfterSeconds: null };

function rateLimited(seconds: number): PurchaseState {
  return { error: "RATE_LIMITED", retryAfterSeconds: seconds };
}

type Outcome = { kind: "state"; state: PurchaseState } | { kind: "login" } | { kind: "refresh" };

async function purchase(videoId: string, tier: FormDataEntryValue | null): Promise<Outcome> {
  if (!isTier(tier)) {
    return { kind: "state", state: failed };
  }
  // The cookie first: without one the user is logged out, whatever the session store's state.
  const sid = (await cookies()).get(sessionCookieName(serverEnv().secure))?.value;
  if (!sid) {
    return { kind: "login" };
  }
  const services = await bffServices().catch(() => null);
  if (!services) {
    return { kind: "state", state: failed };
  }
  const address = clientAddressOf(await headers());
  const access = await services.access.access(sid, address).catch(() => null);
  if (!access) {
    return { kind: "state", state: failed };
  }
  if (access.kind === "none" || access.kind === "expired") {
    return { kind: "login" };
  }
  if (access.kind === "unavailable") {
    return { kind: "state", state: access.status === 429 ? rateLimited(access.retryAfterSeconds ?? 1) : failed };
  }
  const { session } = access;

  let response;
  try {
    ({ response } = await gatewayClient(services.env.gatewayOrigin, session.access_token, address).PUT(
      "/me/entitlements/{video_id}",
      { params: { path: { video_id: videoId } }, body: { tier }, signal: AbortSignal.timeout(purchaseTimeoutMs) },
    ));
  } catch {
    return { kind: "state", state: failed };
  }
  if (response.ok) {
    return { kind: "refresh" };
  }
  if (response.status === 401) {
    // The gateway refuses a token the session just handed out: the session is of no use. Ending it keeps the login
    // page, which sends a logged-in visitor away, from sending the user straight back here.
    await services.access.end(sid, session, address).catch(() => {
      // Redis is down: the session stays until its TTL, and the next request tries again.
    });
    return { kind: "login" };
  }
  if (response.status === 429) {
    return { kind: "state", state: rateLimited(retryAfterSeconds(response)) };
  }
  // 409: the video is not premium, or the viewer is its author and holds every tier; the page shows what holds now.
  return response.status === 409 ? { kind: "refresh" } : { kind: "state", state: failed };
}

/** Records the tier of the form for the logged-in user, then renders the page again with what they now hold. */
export async function purchaseTierAction(_previous: PurchaseState, form: FormData): Promise<PurchaseState> {
  const videoId = form.get("video_id");
  if (typeof videoId !== "string" || !isVideoId(videoId)) {
    return failed;
  }
  const outcome = await purchase(videoId, form.get("tier"));
  // Outside any try/catch: redirect() throws to hand control back to Next.
  if (outcome.kind === "login") {
    redirect(`/login?next=${encodeURIComponent(`/v/${videoId}`)}`);
  }
  if (outcome.kind === "refresh") {
    // The page asks GET /videos/{id} again, which now carries the tier, and plays the full video.
    refresh();
    return initialPurchaseState;
  }
  return outcome.state;
}
