/**
 * Session authentication.
 *
 * A session is a 32-byte random token in an httpOnly, SameSite=Lax cookie. Only
 * its SHA-256 is stored, so a leaked database cannot be replayed as a login.
 * Every request that mutates anything resolves the session, the org membership
 * and the role, and then checks a permission — the UI hiding a button is never
 * treated as the control.
 */
import { cookies, headers } from "next/headers";
import {
  and,
  apiKeys,
  asc,
  db,
  eq,
  gte,
  isNull,
  memberships,
  or,
  organizations,
  sessions,
  users,
  type Role,
} from "@seo/db";
import {
  assertCan,
  authLimit,
  can,
  commandReady,
  hashToken,
  logger,
  newToken,
  RateLimited,
  recordAudit,
  Unauthorized,
  verifyPassword,
  type Actor,
  type Permission,
} from "@seo/core";
import { clientIp } from "./request";

const COOKIE = "seo_session";
const SESSION_DAYS = 14;

export type Session = {
  userId: string;
  email: string;
  name: string | null;
  orgId: string;
  orgName: string;
  role: Role;
  /** How the caller authenticated: a browser session cookie or an API key. */
  via: "session" | "api_key";
};

/** The audit actor for a request — the one place that tells a key from a person. */
export function actorFor(session: Pick<Session, "userId" | "via">, ip: string | null): Actor {
  return { type: session.via === "api_key" ? "API_KEY" : "USER", id: session.userId, ip };
}

/**
 * The session's organization is the one stored on the session row. Sessions
 * from before migration 0004 have none; they act in the user's earliest
 * membership, ordered by (created_at, id) so the choice never changes between
 * requests. A session whose stored org the user has since left resolves to
 * nothing — it is not silently moved into another organization.
 */
export async function currentSession(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;

  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      orgId: memberships.orgId,
      orgName: organizations.name,
      role: memberships.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(
      memberships,
      and(
        eq(memberships.userId, sessions.userId),
        or(isNull(sessions.orgId), eq(memberships.orgId, sessions.orgId)),
      ),
    )
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gte(sessions.expiresAt, new Date())))
    .orderBy(asc(memberships.createdAt), asc(memberships.id))
    .limit(1);

  const row = rows[0];
  return row ? { ...row, via: "session" } : null;
}

export async function requireSession(): Promise<Session> {
  const session = await currentSession();
  if (!session) throw new Unauthorized();
  return session;
}

/** Resolve the session and assert a permission in one step. */
export async function requirePermission(permission: Permission): Promise<Session> {
  const session = await requireSession();
  assertCan(session.role, permission);
  return session;
}

export async function sessionCan(permission: Permission): Promise<boolean> {
  const session = await currentSession();
  return session ? can(session.role, permission) : false;
}

/** Every organization the user belongs to, in the same order the fallback uses. */
export async function userOrgs(userId: string) {
  return db
    .select({ orgId: memberships.orgId, name: organizations.name, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt), asc(memberships.id));
}

/** Point the current browser session at another organization the user belongs to. */
export async function switchOrg(orgId: string): Promise<boolean> {
  const token = (await cookies()).get(COOKIE)?.value;
  const session = await currentSession();
  if (!token || !session) throw new Unauthorized();
  const member = (await userOrgs(session.userId)).some((m) => m.orgId === orgId);
  if (!member) return false;
  await db.update(sessions).set({ orgId }).where(eq(sessions.tokenHash, hashToken(token)));
  return true;
}

// ---------------------------------------------------------------- login

/**
 * Failed logins per account, on top of the per-IP limit: an attacker rotating
 * addresses still gets only this many guesses at one password. Keyed by a hash
 * of the normalized email whether or not the account exists, so the limit itself
 * says nothing about which emails are registered. Only failures count, and a
 * successful login clears the slate.
 */
const ACCOUNT_MAX_FAILURES = 10;
const ACCOUNT_WINDOW_MS = 15 * 60_000;

function accountKey(email: string): string {
  return `loginfail:${hashToken(email)}`;
}

/** Throws RateLimited when the account is locked; fails closed if Redis is unavailable. */
async function assertAccountNotLocked(email: string): Promise<void> {
  let wait = 0;
  try {
    const client = await commandReady();
    const key = accountKey(email);
    const now = Date.now();
    await client.zremrangebyscore(key, "-inf", now - ACCOUNT_WINDOW_MS);
    if ((await client.zcard(key)) >= ACCOUNT_MAX_FAILURES) {
      const oldest = Number((await client.zrange(key, 0, 0, "WITHSCORES"))[1] ?? now);
      wait = Math.max(1, Math.ceil((oldest + ACCOUNT_WINDOW_MS - now) / 1000));
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "login account limiter unavailable");
    throw new RateLimited(30);
  }
  if (wait > 0) throw new RateLimited(wait);
}

async function recordAccountFailure(email: string): Promise<void> {
  try {
    const client = await commandReady();
    const key = accountKey(email);
    await client.zadd(key, Date.now(), `${Date.now()}-${newToken(6)}`);
    await client.pexpire(key, ACCOUNT_WINDOW_MS);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "could not record a failed login");
  }
}

async function clearAccountFailures(email: string): Promise<void> {
  await commandReady()
    .then((client) => client.del(accountKey(email)))
    .catch(() => undefined);
}

export async function login(
  rawEmail: string,
  password: string,
): Promise<{ ok: true; session: Session } | { ok: false }> {
  const hdrs = await headers();
  const ip = clientIp(hdrs);
  const email = rawEmail.trim().toLowerCase();
  await authLimit(ip);
  await assertAccountNotLocked(email);

  const user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];

  // Verify against a dummy hash when the user does not exist, so a missing
  // account and a wrong password take the same time.
  const stored = user?.passwordHash ?? "scrypt$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA";
  const valid = await verifyPassword(password, stored);
  const membership = user
    ? (
        await db
          .select()
          .from(memberships)
          .where(eq(memberships.userId, user.id))
          .orderBy(asc(memberships.createdAt), asc(memberships.id))
          .limit(1)
      )[0]
    : undefined;

  // A user with no organization gets the same answer as a wrong password:
  // anything else would confirm that the password was right.
  if (!user || !valid || !membership) {
    await recordAccountFailure(email);
    if (user && membership) {
      await recordAudit({
        orgId: membership.orgId,
        actor: { type: "USER", id: user.id, ip },
        action: "auth.login_failed",
        metadata: { email },
      });
    }
    return { ok: false };
  }
  await clearAccountFailures(email);

  const token = newToken(32);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    userId: user.id,
    orgId: membership.orgId,
    expiresAt,
    userAgent: hdrs.get("user-agent") ?? null,
    ip,
  });

  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });

  const session = await currentSession();
  if (!session) throw new Unauthorized("Session could not be established");

  await recordAudit({
    orgId: session.orgId,
    actor: { type: "USER", id: user.id, ip },
    action: "auth.login",
  });
  return { ok: true, session };
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) {
    const session = await currentSession();
    await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
    if (session) {
      await recordAudit({
        orgId: session.orgId,
        actor: { type: "USER", id: session.userId, ip: clientIp(await headers()) },
        action: "auth.logout",
      });
    }
  }
  jar.delete(COOKIE);
}

/**
 * API-key authentication for machine callers. Keys are `st_<prefix>_<secret>`;
 * only the secret's hash is stored, and a revoked key is rejected even if the
 * prefix still matches.
 */
export async function authenticateApiKey(header: string | null): Promise<Session | null> {
  if (!header?.startsWith("Bearer ")) return null;
  const raw = header.slice(7).trim();
  const parts = raw.split("_");
  if (parts.length < 3 || parts[0] !== "st") return null;
  const prefix = parts[1]!;
  const secret = parts.slice(2).join("_");

  const rows = await db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix)).limit(1);
  const key = rows[0];
  if (!key || key.revokedAt) return null;
  if (key.hash !== hashToken(secret)) return null;

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id));
  const org = (
    await db.select().from(organizations).where(eq(organizations.id, key.orgId)).limit(1)
  )[0];
  if (!org) return null;

  return {
    userId: `apikey:${key.id}`,
    email: `${key.name}@api-key`,
    name: key.name,
    orgId: org.id,
    orgName: org.name,
    // An API key acts as an EDITOR: it can scan and apply low-risk fixes, but it
    // can never approve a sensitive change. Approval stays a human act.
    role: "EDITOR",
    via: "api_key",
  };
}

export function newApiKey(): { display: string; prefix: string; hash: string } {
  const prefix = newToken(6).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  const secret = newToken(24);
  return { display: `st_${prefix}_${secret}`, prefix, hash: hashToken(secret) };
}
