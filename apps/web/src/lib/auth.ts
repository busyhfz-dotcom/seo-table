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
  db,
  eq,
  gte,
  memberships,
  organizations,
  sessions,
  users,
  type Role,
} from "@seo/db";
import {
  assertCan,
  authLimit,
  can,
  hashToken,
  newToken,
  recordAudit,
  Unauthorized,
  verifyPassword,
  type Permission,
} from "@seo/core";

const COOKIE = "seo_session";
const SESSION_DAYS = 14;

export type Session = {
  userId: string;
  email: string;
  name: string | null;
  orgId: string;
  orgName: string;
  role: Role;
};

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
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gte(sessions.expiresAt, new Date())))
    .limit(1);

  return rows[0] ?? null;
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

export async function login(
  email: string,
  password: string,
): Promise<{ ok: true; session: Session } | { ok: false }> {
  const hdrs = await headers();
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  await authLimit(ip);

  const rows = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  const user = rows[0];

  // Verify against a dummy hash when the user does not exist, so a missing
  // account and a wrong password take the same time.
  const stored = user?.passwordHash ?? "scrypt$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA";
  const valid = await verifyPassword(password, stored);
  if (!user || !valid) {
    const membership = user
      ? (await db.select().from(memberships).where(eq(memberships.userId, user.id)).limit(1))[0]
      : undefined;
    if (membership) {
      await recordAudit({
        orgId: membership.orgId,
        actor: { type: "USER", id: user!.id, ip },
        action: "auth.login_failed",
        metadata: { email },
      });
    }
    return { ok: false };
  }

  const token = newToken(32);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    userId: user.id,
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
        actor: { type: "USER", id: session.userId },
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
  };
}

export function newApiKey(): { display: string; prefix: string; hash: string } {
  const prefix = newToken(6).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  const secret = newToken(24);
  return { display: `st_${prefix}_${secret}`, prefix, hash: hashToken(secret) };
}
