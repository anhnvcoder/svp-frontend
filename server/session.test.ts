import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "./redis";
import {
  absoluteTimeoutMs,
  commandTimeoutMs,
  hashSid,
  idleTimeoutMs,
  isSid,
  lastUseWriteIntervalMs,
  newSid,
  serializeSessionCookie,
  sessionCookieName,
  sessionCookieOptions,
  SessionStore,
  type Session,
  type TokenSet,
} from "./session";
import { fakeTokens } from "./testing/bff";
import { testRedisURL, useTestRedis } from "./testing/redis";

const userId = "01928c6e-7b3a-7cde-8f01-23456789abcd";

describe("sid", () => {
  it("is 32 random bytes in base64url without padding", () => {
    const sid = newSid();
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(sid, "base64url")).toHaveLength(32);
    expect(newSid()).not.toBe(sid);
    expect(isSid(sid)).toBe(true);
  });

  it.each(["", "short", `${"a".repeat(43)}=`, "a".repeat(44), `${"a".repeat(42)}+`])("rejects %j", (value) => {
    expect(isSid(value)).toBe(false);
  });

  it("hashes to sha256 hex", () => {
    expect(hashSid("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("session cookie", () => {
  it("on https is __Host-Http-svp_sid with Secure", () => {
    expect(sessionCookieName(true)).toBe("__Host-Http-svp_sid");
    expect(sessionCookieOptions(true, 2_592_000)).toEqual({
      httpOnly: true,
      secure: true,
      path: "/",
      sameSite: "lax",
      maxAge: 2_592_000,
    });
    expect(serializeSessionCookie(true, "x", 2_592_000)).toBe(
      "__Host-Http-svp_sid=x; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=2592000",
    );
  });

  it("on http://localhost is svp_sid without prefix and without Secure", () => {
    expect(sessionCookieName(false)).toBe("svp_sid");
    expect(sessionCookieOptions(false, 0).secure).toBe(false);
    expect(serializeSessionCookie(false, "", 0)).toBe("svp_sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
  });
});

describe("SessionStore on a Redis that keeps the connection but stops answering", () => {
  it("fails every command after commandTimeoutMs instead of holding the request open", async () => {
    const silent = () => new Promise<never>(() => {});
    const redis = { get: silent, set: silent, del: silent, eval: silent, exists: silent } as unknown as Redis;
    const store = new SessionStore(redis, "svp:test:silent:");
    const sid = newSid();
    const tokens = fakeTokens(userId);
    const session: Session = {
      ver: 1,
      user_id: userId,
      access_token: tokens.access_token,
      access_expires_at: tokens.expires_at,
      refresh_token: tokens.refresh_token,
      refresh_expires_at: tokens.refresh_expires_at,
      created_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
    };
    vi.useFakeTimers();
    try {
      const outcomes = Promise.allSettled([
        store.create(userId, tokens),
        store.get(sid),
        store.delete(sid),
        store.compareAndSet(sid, session, fakeTokens(userId)),
        store.compareAndDelete(sid, session),
        store.acquireLock(sid, 5000),
        store.releaseLock(sid, "holder"),
        store.lockHeld(sid),
      ]);
      await vi.advanceTimersByTimeAsync(commandTimeoutMs);
      for (const outcome of await outcomes) {
        expect(outcome).toMatchObject({ status: "rejected", reason: { message: /no answer within 1000 ms/ } });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(!testRedisURL)("SessionStore on the test Redis", () => {
  const redis = useTestRedis();
  const store = () => new SessionStore(redis.client(), redis.prefix());

  it("stores the session under the hash of the sid, never the sid, expiring at the earliest deadline", async () => {
    const tokens = fakeTokens(userId);
    const { sid, session } = await store().create(userId, tokens);

    expect(session).toMatchObject({
      ver: 1,
      user_id: userId,
      access_token: tokens.access_token,
      access_expires_at: tokens.expires_at,
      refresh_token: tokens.refresh_token,
      refresh_expires_at: tokens.refresh_expires_at,
    });
    const keys = await redis.client().keys(`${redis.prefix()}*`);
    expect(keys).toEqual([`${redis.prefix()}sess:${hashSid(sid)}`]);
    expect(keys.join()).not.toContain(sid);
    const expireAt = await redis.client().pExpireTime(keys[0] ?? "");
    // The 7-day idle deadline comes before the refresh token's 14 days.
    expect(expireAt).toBe(Date.parse(session.last_used_at) + idleTimeoutMs);
    expect(await store().get(sid)).toEqual(session);
  });

  it("gives a fresh sid for every session", async () => {
    const a = await store().create(userId, fakeTokens(userId));
    const b = await store().create(userId, fakeTokens(userId));
    expect(a.sid).not.toBe(b.sid);
  });

  it("reads null for an unknown sid, a malformed sid and a value that is not a session", async () => {
    expect(await store().get(newSid())).toBeNull();
    expect(await store().get("../../etc")).toBeNull();
    const sid = newSid();
    await redis
      .client()
      .set(`${redis.prefix()}sess:${hashSid(sid)}`, "{not json", { expiration: { type: "EX", value: 60 } });
    expect(await store().get(sid)).toBeNull();
  });

  it("deletes a session", async () => {
    const { sid } = await store().create(userId, fakeTokens(userId));
    await store().delete(sid);
    expect(await store().get(sid)).toBeNull();
  });

  it("compare-and-set writes only at the version read, and never brings a deleted session back", async () => {
    const { sid, session } = await store().create(userId, fakeTokens(userId));
    const newer = fakeTokens(userId);

    const written = await store().compareAndSet(sid, session, newer);
    expect(written).toMatchObject({ ver: 2, refresh_token: newer.refresh_token });
    expect(await store().get(sid)).toEqual(written);
    expect(await redis.client().pExpireTime(`${redis.prefix()}sess:${hashSid(sid)}`)).toBe(
      Date.parse(written!.last_used_at) + idleTimeoutMs,
    );

    // A second writer that read version 1 loses.
    expect(await store().compareAndSet(sid, session, fakeTokens(userId))).toBeNull();
    expect(await store().get(sid)).toEqual(written);

    await store().delete(sid);
    expect(await store().compareAndSet(sid, written!, fakeTokens(userId))).toBeNull();
    expect(await store().get(sid)).toBeNull();
  });

  it("compare-and-delete deletes only at the version read", async () => {
    const { sid, session } = await store().create(userId, fakeTokens(userId));
    const written = await store().compareAndSet(sid, session, fakeTokens(userId));
    expect(await store().compareAndDelete(sid, session)).toBe(false);
    expect(await store().get(sid)).not.toBeNull();
    expect(await store().compareAndDelete(sid, written!)).toBe(true);
    expect(await store().get(sid)).toBeNull();
  });

  it("the refresh lease has one holder, expires, and is freed only by its holder", async () => {
    // A lease far longer than the 5 s a test may run, so its TTL is checked against a bound no slow machine can cross
    // while the test still passes.
    const leaseMs = 60_000;
    const sid = newSid();
    const first = await store().acquireLock(sid, leaseMs);
    expect(first).not.toBeNull();
    expect(await store().acquireLock(sid, leaseMs)).toBeNull();
    expect(await redis.client().pTTL(`${redis.prefix()}lock:${hashSid(sid)}`)).toBeGreaterThan(leaseMs - 5000);

    await store().releaseLock(sid, "someone-else");
    expect(await store().lockHeld(sid)).toBe(true);
    await store().releaseLock(sid, first!);
    expect(await store().lockHeld(sid)).toBe(false);
  });
});

const day = 24 * 3_600_000;

// Tokens whose refresh token outlives the 30-day absolute deadline, so the idle and absolute deadlines decide.
function tokensUntil(refreshExpiresAt: number, accessExpiresAt = refreshExpiresAt): TokenSet {
  return {
    ...fakeTokens(userId),
    expires_at: new Date(accessExpiresAt).toISOString(),
    refresh_expires_at: new Date(refreshExpiresAt).toISOString(),
  };
}

describe.skipIf(!testRedisURL)("SessionStore idle and absolute timeouts on the test Redis", () => {
  const redis = useTestRedis();
  // The clock starts at the real time and only moves forward, so every key's expiry is still ahead of Redis's own
  // clock and the store, not Redis, has to notice a deadline.
  const start = Date.now();
  let clock = start;
  const store = () => new SessionStore(redis.client(), redis.prefix(), () => clock);
  const key = (sid: string) => `${redis.prefix()}sess:${hashSid(sid)}`;

  beforeEach(() => {
    clock = start;
  });

  it("uses 7 days idle, 30 days absolute and a write of the last use at most once an hour", () => {
    expect(idleTimeoutMs).toBe(7 * day);
    expect(absoluteTimeoutMs).toBe(30 * day);
    expect(lastUseWriteIntervalMs).toBe(3_600_000);
  });

  it("reads null and deletes the key once a session has gone 7 days without use", async () => {
    const { sid, session } = await store().create(userId, tokensUntil(start + 60 * day));
    expect(session.last_used_at).toBe(session.created_at);
    clock = start + 7 * day - 1;
    expect(await store().get(sid)).toEqual(session);
    clock = start + 7 * day;
    expect(await store().get(sid)).toBeNull();
    expect(await redis.client().exists(key(sid))).toBe(0);
  });

  it("a use within the idle timeout extends the session, up to 30 days after login and no further", async () => {
    const created = await store().create(userId, tokensUntil(start + 60 * day));
    const sid = created.sid;
    let session = created.session;
    for (const at of [6, 12, 18, 24]) {
      clock = start + at * day;
      session = await store().touch(sid, session);
      expect(session.last_used_at).toBe(new Date(clock).toISOString());
      expect(await store().get(sid)).toEqual(session);
    }
    // Used on day 24, so idle runs to day 31; the absolute deadline on day 30 comes first.
    expect(await redis.client().pExpireTime(key(sid))).toBe(start + 30 * day);
    clock = start + 30 * day - 1;
    session = await store().touch(sid, session);
    expect(await store().get(sid)).toEqual(session);
    clock = start + 30 * day;
    expect(await store().get(sid)).toBeNull();
    expect(await redis.client().exists(key(sid))).toBe(0);
  });

  it("writes the last use at most once an hour, keeping the version", async () => {
    const { sid, session } = await store().create(userId, tokensUntil(start + 60 * day));
    clock = start + lastUseWriteIntervalMs - 1;
    const unchanged = await store().touch(sid, session);
    expect(unchanged).toBe(session);
    expect(await store().get(sid)).toEqual(session);

    clock = start + lastUseWriteIntervalMs;
    const touched = await store().touch(sid, session);
    expect(touched).toEqual({ ...session, last_used_at: new Date(clock).toISOString() });
    expect(await store().get(sid)).toEqual(touched);
    expect(touched.ver).toBe(1);
    expect(await redis.client().pExpireTime(key(sid))).toBe(clock + 7 * day);
  });

  it("a write of the last use never overwrites a newer version nor brings a deleted session back", async () => {
    const { sid, session } = await store().create(userId, tokensUntil(start + 60 * day));
    const refreshed = await store().compareAndSet(sid, session, tokensUntil(start + 60 * day));
    clock = start + 2 * lastUseWriteIntervalMs;
    expect(await store().touch(sid, session)).toBe(session);
    expect(await store().get(sid)).toEqual(refreshed);

    await store().delete(sid);
    await store().touch(sid, refreshed!);
    expect(await redis.client().exists(key(sid))).toBe(0);
  });

  it("the key expires at the earliest of the refresh token's expiry, idle and absolute", async () => {
    // The refresh token first.
    const short = await store().create(userId, tokensUntil(start + 3 * day));
    expect(await redis.client().pExpireTime(key(short.sid))).toBe(start + 3 * day);

    // The idle timeout first, at login and after a refresh, which counts as a use.
    const { sid, session } = await store().create(userId, tokensUntil(start + 60 * day));
    expect(await redis.client().pExpireTime(key(sid))).toBe(start + 7 * day);
    clock = start + 5 * day;
    const refreshed = await store().compareAndSet(sid, session, tokensUntil(start + 60 * day));
    expect(refreshed?.last_used_at).toBe(new Date(clock).toISOString());
    expect(await redis.client().pExpireTime(key(sid))).toBe(start + 12 * day);

    // The absolute deadline first.
    clock = start + 25 * day;
    await store().compareAndSet(sid, refreshed!, tokensUntil(start + 60 * day));
    expect(await redis.client().pExpireTime(key(sid))).toBe(start + 30 * day);
  });

  it("the cookie's Max-Age is the whole seconds left until the absolute deadline, rounded up", async () => {
    const { session } = await store().create(userId, tokensUntil(start + 60 * day));
    expect(store().cookieMaxAgeSeconds(session)).toBe(2_592_000);
    clock = start + 10 * day + 500;
    expect(store().cookieMaxAgeSeconds(session)).toBe(20 * 24 * 3600);
    clock = start + 31 * day;
    expect(store().cookieMaxAgeSeconds(session)).toBe(0);
  });

  it("a session stored without last_used_at counts its login as the last use", async () => {
    const tokens = tokensUntil(start + 60 * day);
    const stored = (createdAt: number) => ({
      ver: 1,
      user_id: userId,
      access_token: tokens.access_token,
      access_expires_at: tokens.expires_at,
      refresh_token: tokens.refresh_token,
      refresh_expires_at: tokens.refresh_expires_at,
      created_at: new Date(createdAt).toISOString(),
    });
    const write = async (value: object) => {
      const sid = newSid();
      await redis.client().set(key(sid), JSON.stringify(value), { expiration: { type: "EX", value: 60 } });
      return sid;
    };

    const recent = await write(stored(start - day));
    expect(await store().get(recent)).toEqual({ ...stored(start - day), last_used_at: stored(start - day).created_at });

    const old = await write(stored(start - 7 * day));
    expect(await store().get(old)).toBeNull();
    expect(await redis.client().exists(key(old))).toBe(0);
    // read still sees it, for a logout that revokes its family.
    const kept = await write(stored(start - 7 * day));
    expect(await store().read(kept)).toMatchObject({ created_at: new Date(start - 7 * day).toISOString() });
  });
});
