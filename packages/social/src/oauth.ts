/**
 * Instagram Login: the signed `state` that ties a consent round-trip to the
 * person, organization and project that started it, and the callback's work
 * (code → short-lived → long-lived token → profile → sealed store).
 *
 * The state is an HMAC over {user, org, project, nonce, expiry}. The callback
 * accepts it only for the same signed-in user, so a link crafted by someone
 * else — with their own code and state — cannot attach their Instagram
 * account to a victim's project, and a state cannot be replayed after ten
 * minutes.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { Project, SocialAccount } from "@seo/db";
import { constantTimeEquals, env } from "@seo/core";
import {
  InstagramError,
  exchangeInstagramCode,
  instagramAuthorizeUrl,
  instagramClient,
  longLivedInstagramToken,
} from "@seo/connectors";
import { assertSocialProject, instagramApp, storeInstagramToken } from "./accounts.js";

const STATE_TTL_MS = 10 * 60_000;

export type OAuthState = { u: string; o: string; p: string; n: string; e: number };

function sign(payload: string): string {
  return createHmac("sha256", env().SESSION_SECRET).update(`instagram-oauth:${payload}`).digest("base64url");
}

export function createState(input: { userId: string; orgId: string; projectId: string }, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ u: input.userId, o: input.orgId, p: input.projectId, n: randomBytes(12).toString("base64url"), e: now + STATE_TTL_MS }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The state's claims, or null when forged, malformed or expired. */
export function verifyState(state: string | null | undefined, now = Date.now()): OAuthState | null {
  if (!state || state.length > 2000) return null;
  const [payload, sig] = state.split(".");
  if (!payload || !sig || !constantTimeEquals(sig, sign(payload))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    if (typeof claims.e !== "number" || claims.e < now) return null;
    if (![claims.u, claims.o, claims.p].every((v) => typeof v === "string" && v.length > 0)) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Where to send the owner for consent; `not_configured` without an Instagram app. */
export function startInstagramOAuth(
  project: Project,
  userId: string,
): { ok: true; url: string } | { ok: false; reason: "not_configured" } {
  assertSocialProject(project, "INSTAGRAM");
  const app = instagramApp();
  if (!app) return { ok: false, reason: "not_configured" };
  return { ok: true, url: instagramAuthorizeUrl(app, createState({ userId, orgId: project.orgId, projectId: project.id })) };
}

/**
 * Finish the flow. Resolves {ok:false, reason} for anything the owner can fix
 * (a personal account, a refused exchange), so the callback can say so.
 */
export async function completeInstagramOAuth(
  project: Project,
  code: string,
  userId: string,
): Promise<{ ok: true; account: SocialAccount } | { ok: false; reason: string }> {
  assertSocialProject(project, "INSTAGRAM");
  const app = instagramApp();
  if (!app) return { ok: false, reason: "not_configured" };
  try {
    const grant = await exchangeInstagramCode(app, code);
    const long = await longLivedInstagramToken(app, grant.accessToken);
    const profile = await instagramClient(long.accessToken, grant.userId).profile();
    if (profile.accountType && !/BUSINESS|CREATOR/i.test(profile.accountType)) return { ok: false, reason: "personal_account" };
    const account = await storeInstagramToken(project, {
      userId: grant.userId,
      accessToken: long.accessToken,
      expiresAt: long.expiresAt,
      permissions: grant.permissions,
      profile,
      connectedBy: userId,
    });
    return { ok: true, account };
  } catch (err) {
    if (err instanceof InstagramError) return { ok: false, reason: err.code };
    throw err;
  }
}
