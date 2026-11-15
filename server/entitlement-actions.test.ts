import { http, HttpResponse } from "msw";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialPurchaseState } from "@/features/feed/purchase";
import { server } from "@/lib/test/msw-server";
import type { BffServices } from "./runtime";
import { accessTokenBody, fakeTokens, gatewayOrigin, gatewayProblem, recordLogouts, testServices } from "./testing/bff";
import { testRedisURL, useTestRedis } from "./testing/redis";

// The action runs outside a Next request here: cookies() and headers() are stand-ins, the services come from the test,
// redirect() is Next's own (it throws an error naming the target), and refresh() is recorded.
const request = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Headers(),
  services: undefined as BffServices | undefined,
  refreshes: 0,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = request.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => request.headers,
}));
vi.mock("next/cache", () => ({
  refresh: () => {
    request.refreshes++;
  },
}));
vi.mock("./runtime", () => ({
  bffServices: async () => {
    if (!request.services) {
      throw new Error("redis down");
    }
    return request.services;
  },
}));
vi.mock("./env", () => ({ serverEnv: () => request.services?.env ?? { secure: false } }));

const { purchaseTierAction } = await import("./entitlement-actions");

const userId = "01928c6e-7b3a-7cde-8f01-23456789abcd";
const videoId = "01928c6e-7b3a-7cde-8f01-000000000001";
const loginTarget = `/login?next=${encodeURIComponent(`/v/${videoId}`)}`;
const failed = { error: "FAILED", retryAfterSeconds: null };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.set(name, value);
  }
  return data;
}

const buy = (tier: string, id = videoId) => purchaseTierAction(initialPurchaseState, form({ video_id: id, tier }));

async function redirectTarget(run: Promise<unknown>): Promise<string> {
  const error = await run.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(isRedirectError(error)).toBe(true);
  return isRedirectError(error) ? getURLFromRedirectError(error) : "";
}

// Records each PUT /me/entitlements/{id} and answers it.
function entitlementServer(answer: () => Response = () => HttpResponse.json({})) {
  const calls: { path: string; body: unknown; authorization: string | null; forwardedFor: string | null }[] = [];
  server.use(
    http.put(`${gatewayOrigin}/me/entitlements/:id`, async ({ request: call }) => {
      calls.push({
        path: new URL(call.url).pathname,
        body: await call.json(),
        authorization: call.headers.get("authorization"),
        forwardedFor: call.headers.get("x-forwarded-for"),
      });
      return answer();
    }),
  );
  return calls;
}

beforeEach(() => {
  request.cookies.clear();
  request.headers = new Headers({ "x-forwarded-for": "203.0.113.9" });
  request.services = undefined;
  request.refreshes = 0;
});

describe("purchaseTierAction before the session is looked at", () => {
  it.each([
    ["no video id", { tier: "sd" }],
    ["a video id that is not a canonical UUID", { video_id: videoId.toUpperCase(), tier: "sd" }],
    ["a path in the video id", { video_id: `${videoId}/../../me`, tier: "sd" }],
    ["no tier", { video_id: videoId }],
    ["an unknown tier", { video_id: videoId, tier: "4k" }],
    ["an upper case tier", { video_id: videoId, tier: "SD" }],
  ])("refuses %s, without calling anything", async (_name, fields) => {
    request.cookies.set("svp_sid", "d".repeat(43));
    const calls = entitlementServer();
    expect(await purchaseTierAction(initialPurchaseState, form(fields))).toEqual(failed);
    expect(calls).toEqual([]);
    expect(request.refreshes).toBe(0);
  });

  it("sends a user without a session cookie to log in and back to the video", async () => {
    expect(await redirectTarget(buy("sd"))).toBe(loginTarget);
  });

  it("fails when the session store cannot be reached", async () => {
    request.cookies.set("svp_sid", "d".repeat(43));
    expect(await buy("sd")).toEqual(failed);
  });
});

describe.skipIf(!testRedisURL)("purchaseTierAction on the test Redis", () => {
  const redis = useTestRedis();

  async function logIn(accessExpiresInMs?: number) {
    const tokens = fakeTokens(userId, accessExpiresInMs);
    const { sid } = await request.services!.store.create(userId, tokens);
    request.cookies.set("svp_sid", sid);
    return { sid, tokens };
  }

  beforeEach(() => {
    request.services = testServices(redis.client(), redis.prefix());
  });

  it.each(["sd", "hd", "fhd"])(
    "sends PUT /me/entitlements/{id} with %s and the session's token, then renders the page again",
    async (tier) => {
      const { tokens } = await logIn();
      const calls = entitlementServer(() =>
        HttpResponse.json({ video_id: videoId, tier, granted_at: "2026-11-15T01:00:00Z" }),
      );
      const state = await buy(tier);
      expect(state).toEqual(initialPurchaseState);
      expect(calls).toEqual([
        {
          path: `/me/entitlements/${videoId}`,
          body: { tier },
          authorization: `Bearer ${tokens.access_token}`,
          forwardedFor: "203.0.113.9",
        },
      ]);
      expect(request.refreshes).toBe(1);
      expect(JSON.stringify(state)).not.toContain("eyJ");
    },
  );

  it.each(["VIDEO_NOT_PREMIUM", "ALREADY_ENTITLED"])(
    "renders the page again on 409 %s: it then shows what holds",
    async (code) => {
      await logIn();
      entitlementServer(() => gatewayProblem(409, code));
      expect(await buy("hd")).toEqual(initialPurchaseState);
      expect(request.refreshes).toBe(1);
    },
  );

  it("waits for Retry-After on a 429", async () => {
    await logIn();
    entitlementServer(() => gatewayProblem(429, "RATE_LIMITED", { "Retry-After": "7" }));
    expect(await buy("sd")).toEqual({ error: "RATE_LIMITED", retryAfterSeconds: 7 });
    expect(request.refreshes).toBe(0);
  });

  it.each([
    ["404 VIDEO_NOT_FOUND", () => gatewayProblem(404, "VIDEO_NOT_FOUND")],
    ["400 INVALID_TIER", () => gatewayProblem(400, "INVALID_TIER")],
    ["503", () => gatewayProblem(503, "UNAVAILABLE")],
  ])("fails on %s without rendering again", async (_name, answer) => {
    await logIn();
    entitlementServer(answer);
    expect(await buy("sd")).toEqual(failed);
    expect(request.refreshes).toBe(0);
  });

  it("ends the session and sends the user to log in when the gateway refuses its token", async () => {
    const { sid, tokens } = await logIn();
    const logouts = recordLogouts();
    entitlementServer(() => gatewayProblem(401, "UNAUTHENTICATED"));
    expect(await redirectTarget(buy("sd"))).toBe(loginTarget);
    expect(await request.services!.store.get(sid)).toBeNull();
    expect(logouts).toEqual([tokens.refresh_token]);
  });

  it("refreshes an expired access token first", async () => {
    await logIn(-1000);
    const refreshed = fakeTokens(userId);
    server.use(http.post(`${gatewayOrigin}/auth/refresh`, () => HttpResponse.json(accessTokenBody(refreshed))));
    const calls = entitlementServer();
    await buy("sd");
    expect(calls[0]?.authorization).toBe(`Bearer ${refreshed.access_token}`);
  });
});
