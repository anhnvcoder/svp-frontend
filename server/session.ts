import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { withTimeout, type Redis } from "./redis";

// Server-side sessions in Redis. The browser holds only a random session id
// (sid) in an HttpOnly cookie; the tokens stay here and never reach a page, a response or a log.

// Keys: <prefix>sess:<sha256(sid) hex> holds the session JSON, <prefix>lock:<sha256(sid) hex> the refresh lease. Only
// the hash is stored, so whoever reads Redis (KEYS, a dump) cannot rebuild a cookie. The prefix is svp:web: in the app
// and a random svp:test:<hex>: in tests.

export const defaultKeyPrefix = "svp:web:";

// A session ends after 7 days without use or 30 days after login, whichever comes first, and never later than its
// refresh token. Its Redis key expires at the earliest of the three; a key read past either deadline (written before
// these limits existed, or a clock ahead of Redis) counts as gone. The use is written at most once an hour, so the
// idle timeout may fall up to an hour short of 7 days after the last request.
export const idleTimeoutMs = 7 * 24 * 3_600_000;
export const absoluteTimeoutMs = 30 * 24 * 3_600_000;
export const lastUseWriteIntervalMs = 3_600_000;

const storedSessionSchema = z.object({
  // Grows by one at every write, for compare-and-set.
  ver: z.number().int().positive(),
  user_id: z.string(),
  access_token: z.string(),
  access_expires_at: z.string(),
  refresh_token: z.string(),
  refresh_expires_at: z.string(),
  created_at: z.string(),
  // Missing in a session written before the idle timeout existed: its last use counts as the login, so a session
  // whose last use is unknown ends rather than lives on.
  last_used_at: z.string().optional(),
});

const sessionSchema = storedSessionSchema.transform((session) => ({
  ...session,
  last_used_at: session.last_used_at ?? session.created_at,
}));

export type Session = z.output<typeof sessionSchema>;

export interface TokenSet {
  access_token: string;
  expires_at: string;
  refresh_token: string;
  refresh_expires_at: string;
}

// 32 random bytes, base64url without padding: always 43 characters.
export function newSid(): string {
  return randomBytes(32).toString("base64url");
}

const sidPattern = /^[A-Za-z0-9_-]{43}$/;

export function isSid(value: string): boolean {
  return sidPattern.test(value);
}

export function hashSid(sid: string): string {
  return createHash("sha256").update(sid).digest("hex");
}

// http://localhost (compose, `make dev`) gets a cookie without Secure and without a prefix: WebKit drops Secure
// cookies set from http://localhost (WebKit bug 232088), and __Host- requires Secure. https gets __Host-Http-: no
// Domain, so sibling hosts such as s3.svp.localhost cannot overwrite it, and HttpOnly is enforced by the name.
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-Http-svp_sid" : "svp_sid";
}

export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  path: "/";
  // Lax, not Strict: a link to a video opened from another site must arrive logged in. CSRF is stopped by the
  // Fetch Metadata check of proxy.ts, not by SameSite.
  sameSite: "lax";
  maxAge: number;
}

export function sessionCookieOptions(secure: boolean, maxAge: number): SessionCookieOptions {
  return { httpOnly: true, secure, path: "/", sameSite: "lax", maxAge };
}

// The Set-Cookie value for handlers that build their response by hand; the same name and attributes as the cookie set
// at login, which a browser needs to replace or delete it.
export function serializeSessionCookie(secure: boolean, value: string, maxAge: number): string {
  return [
    `${sessionCookieName(secure)}=${value}`,
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

// Writes the new session only if the key still exists and still holds the version read before; a session deleted by
// a logout during a refresh is not brought back, and a write that lost a race does not overwrite the winner.
const compareAndSetScript = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, session = pcall(cjson.decode, current)
if not ok or type(session) ~= 'table' or session.ver ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PXAT', ARGV[3])
return 1
`;

const compareAndDeleteScript = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, session = pcall(cjson.decode, current)
if not ok or type(session) ~= 'table' or session.ver ~= tonumber(ARGV[1]) then return 0 end
return redis.call('DEL', KEYS[1])
`;

// Deletes the lease only while it still holds this holder's random value: a holder whose lease ran out must not free
// the lease another replica took since.
const releaseLockScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

// How long a session command waits for its answer. The Redis client times out only commands it has not written yet
// (and, without an offline queue, fails them at once while disconnected); a command written to a Redis that keeps the
// connection open but stops answering would wait until TCP gives up, and hold its request open as long.
export const commandTimeoutMs = 1000;

function bounded<T>(command: Promise<T>): Promise<T> {
  return withTimeout(command, commandTimeoutMs, "no answer");
}

export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = defaultKeyPrefix,
    private readonly now: () => number = Date.now,
  ) {}

  private sessionKey(sid: string): string {
    return `${this.prefix}sess:${hashSid(sid)}`;
  }

  private lockKey(sid: string): string {
    return `${this.prefix}lock:${hashSid(sid)}`;
  }

  // Stores a new session under a fresh sid.
  async create(userId: string, tokens: TokenSet): Promise<{ sid: string; session: Session }> {
    const sid = newSid();
    const now = new Date(this.now()).toISOString();
    const session: Session = {
      ver: 1,
      user_id: userId,
      ...sessionTokens(tokens),
      created_at: now,
      last_used_at: now,
    };
    await bounded(
      this.redis.set(this.sessionKey(sid), JSON.stringify(session), {
        condition: "NX",
        expiration: { type: "PXAT", value: keyExpiresAt(session) },
      }),
    );
    return { sid, session };
  }

  // The live session of sid, or null for a malformed sid (no Redis call), an unknown one, a value that is not a
  // session, or a session past its idle or absolute deadline, which is deleted.
  async get(sid: string): Promise<Session | null> {
    const session = await this.read(sid);
    if (session && this.expired(session)) {
      await this.compareAndDelete(sid, session);
      return null;
    }
    return session;
  }

  // The stored session of sid, past its deadlines or not; null as for get otherwise.
  async read(sid: string): Promise<Session | null> {
    if (!isSid(sid)) {
      return null;
    }
    const raw = await bounded(this.redis.get(this.sessionKey(sid)));
    if (raw === null) {
      return null;
    }
    try {
      const parsed = sessionSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async delete(sid: string): Promise<void> {
    if (isSid(sid)) {
      await bounded(this.redis.del(this.sessionKey(sid)));
    }
  }

  // True once the session is past its idle or absolute deadline.
  expired(session: Session): boolean {
    const now = this.now();
    return now >= idleDeadline(session) || now >= absoluteDeadline(session);
  }

  // The cookie's Max-Age: the whole seconds left until the absolute deadline, rounded up.
  cookieMaxAgeSeconds(session: Session): number {
    return Math.max(0, Math.ceil((absoluteDeadline(session) - this.now()) / 1000));
  }

  // Replaces the tokens of the session at version `expected` and records the use; returns the new session, or null
  // when the session is gone or was written by someone else since.
  async compareAndSet(sid: string, expected: Session, tokens: TokenSet): Promise<Session | null> {
    const next: Session = {
      ...expected,
      ...sessionTokens(tokens),
      ver: expected.ver + 1,
      last_used_at: new Date(this.now()).toISOString(),
    };
    return (await this.write(sid, expected, next)) ? next : null;
  }

  // Records a use of the session when the last one written is an hour old or more, and returns the session as it now
  // stands. The version stays the same: a refresh that read the session before this write still wins its
  // compare-and-set, so it never takes the replay path that revokes the family. A write that lost to another writer
  // is dropped; the next request tries again.
  async touch(sid: string, session: Session): Promise<Session> {
    const now = this.now();
    if (now - Date.parse(session.last_used_at) < lastUseWriteIntervalMs) {
      return session;
    }
    const next: Session = { ...session, last_used_at: new Date(now).toISOString() };
    return (await this.write(sid, session, next)) ? next : session;
  }

  private async write(sid: string, expected: Session, next: Session): Promise<boolean> {
    const written = await bounded(
      this.redis.eval(compareAndSetScript, {
        keys: [this.sessionKey(sid)],
        arguments: [String(expected.ver), JSON.stringify(next), String(keyExpiresAt(next))],
      }),
    );
    return written === 1;
  }

  // Deletes the session only while it is still at version `expected`.
  async compareAndDelete(sid: string, expected: Session): Promise<boolean> {
    const deleted = await bounded(
      this.redis.eval(compareAndDeleteScript, { keys: [this.sessionKey(sid)], arguments: [String(expected.ver)] }),
    );
    return deleted === 1;
  }

  // Takes the refresh lease of sid for leaseMs; returns the holder's random value, or null when another holds it.
  async acquireLock(sid: string, leaseMs: number): Promise<string | null> {
    const holder = randomBytes(16).toString("hex");
    const taken = await bounded(
      this.redis.set(this.lockKey(sid), holder, { condition: "NX", expiration: { type: "PX", value: leaseMs } }),
    );
    return taken === "OK" ? holder : null;
  }

  async releaseLock(sid: string, holder: string): Promise<void> {
    await bounded(this.redis.eval(releaseLockScript, { keys: [this.lockKey(sid)], arguments: [holder] }));
  }

  async lockHeld(sid: string): Promise<boolean> {
    return (await bounded(this.redis.exists(this.lockKey(sid)))) === 1;
  }
}

function idleDeadline(session: Session): number {
  return Date.parse(session.last_used_at) + idleTimeoutMs;
}

function absoluteDeadline(session: Session): number {
  return Date.parse(session.created_at) + absoluteTimeoutMs;
}

// The key lives until the earliest of the refresh token's expiry and the two deadlines.
function keyExpiresAt(session: Session): number {
  return Math.min(Date.parse(session.refresh_expires_at), idleDeadline(session), absoluteDeadline(session));
}

function sessionTokens(
  tokens: TokenSet,
): Pick<Session, "access_token" | "access_expires_at" | "refresh_token" | "refresh_expires_at"> {
  return {
    access_token: tokens.access_token,
    access_expires_at: tokens.expires_at,
    refresh_token: tokens.refresh_token,
    refresh_expires_at: tokens.refresh_expires_at,
  };
}
