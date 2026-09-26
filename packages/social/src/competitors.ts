/**
 * Competitor profiles of a social project.
 *
 * Telegram: the channel's public preview (subscribers, recent posts and their
 * views). Instagram: Business Discovery when the connected token supports it;
 * with Instagram Login it usually does not, and the competitor is then marked
 * `unsupported` — instagram.com itself is never scraped.
 */
import { z } from "zod";
import { and, asc, db, eq, socialAccounts, socialCompetitors, sql, type SocialCompetitor, type SocialCompetitorSnapshot } from "@seo/db";
import { BadRequest, Conflict, NotFound } from "@seo/core";
import { ConnectorError, InstagramError, instagramClient, postsPerWeek, USERNAME } from "@seo/connectors";
import { connectedAccount, getAccount } from "./accounts.js";
import { cachedPreview } from "./preview.js";
import { mean } from "./text.js";
import { socialReasonText } from "./reasons.js";

export const MAX_SOCIAL_COMPETITORS = 10;

export const competitorInput = z.object({
  username: z
    .string()
    .trim()
    .transform((v) => v.replace(/^https?:\/\/(www\.)?(instagram\.com|t\.me)\/(s\/)?/i, "").replace(/^@/, "").replace(/\/.*$/, "").toLowerCase())
    .pipe(z.string().regex(/^[a-z0-9._]{2,32}$/, "must be a username")),
});

export function competitorView(c: SocialCompetitor) {
  return {
    id: c.id,
    platform: c.platform,
    username: c.username,
    status: c.status,
    statusText: c.status === "ok" || c.status === "pending" ? null : socialReasonText(c.lastError ?? c.status),
    snapshot: c.snapshot,
    fetchedAt: c.fetchedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function listCompetitors(projectId: string): Promise<SocialCompetitor[]> {
  return db.select().from(socialCompetitors).where(eq(socialCompetitors.projectId, projectId)).orderBy(asc(socialCompetitors.createdAt));
}

export async function addCompetitor(projectId: string, input: z.infer<typeof competitorInput>): Promise<SocialCompetitor> {
  const account = await getAccount(projectId);
  if (!account) throw new NotFound("No social account for this project");
  if (account.platform === "TELEGRAM" && !USERNAME.test(input.username)) throw new BadRequest("Not a Telegram channel username");
  const existing = await listCompetitors(projectId);
  if (existing.length >= MAX_SOCIAL_COMPETITORS) throw new Conflict(`At most ${MAX_SOCIAL_COMPETITORS} competitors per project`);
  const inserted = await db
    .insert(socialCompetitors)
    .values({ projectId, platform: account.platform, username: input.username })
    .onConflictDoNothing()
    .returning();
  if (!inserted[0]) throw new Conflict("This competitor is already tracked");
  return inserted[0];
}

export async function deleteCompetitor(projectId: string, id: string): Promise<void> {
  const deleted = await db
    .delete(socialCompetitors)
    .where(and(eq(socialCompetitors.projectId, projectId), eq(socialCompetitors.id, id)))
    .returning({ id: socialCompetitors.id });
  if (!deleted.length) throw new NotFound("Competitor not found");
}

async function telegramSnapshot(username: string): Promise<SocialCompetitorSnapshot> {
  const preview = await cachedPreview(username, 2);
  const views = preview.posts.map((p) => p.views).filter((v): v is number => v !== null);
  return {
    source: "public_preview",
    name: preview.title,
    bio: preview.description,
    followers: preview.subscribers,
    mediaCount: null,
    recent: preview.posts.slice(0, 30).map((p) => ({ at: p.publishedAt, views: p.views })),
    postsPerWeek: postsPerWeek(preview.posts.map((p) => p.publishedAt)),
    avgViews: views.length ? Math.round(mean(views)!) : null,
    avgInteractions: null,
  };
}

/** Refresh one competitor, or every one of the project's. Failures are recorded per competitor. */
export async function refreshCompetitors(projectId: string, competitorId?: string, now = new Date()): Promise<SocialCompetitor[]> {
  const all = await listCompetitors(projectId);
  const targets = competitorId ? all.filter((c) => c.id === competitorId) : all;
  if (competitorId && !targets.length) throw new NotFound("Competitor not found");
  let igClient: ReturnType<typeof instagramClient> | null = null;
  if (targets.some((c) => c.platform === "INSTAGRAM")) {
    const account = await connectedAccount(projectId);
    igClient = instagramClient(account.secret.accessToken ?? "", account.externalId!);
  }
  let igUnsupported = false;
  const out: SocialCompetitor[] = [];
  for (const c of targets) {
    let values: Partial<SocialCompetitor>;
    if (c.platform === "INSTAGRAM" && igUnsupported) {
      values = { status: "unsupported", lastError: "unsupported", fetchedAt: now };
    } else {
      try {
        const snapshot = c.platform === "TELEGRAM" ? await telegramSnapshot(c.username) : await igClient!.businessDiscovery(c.username);
        values = { snapshot, status: "ok", lastError: null, fetchedAt: now };
      } catch (err) {
        if (!(err instanceof ConnectorError)) throw err;
        // One refusal of Business Discovery answers for every other Instagram competitor.
        if (err instanceof InstagramError && err.code === "unsupported") igUnsupported = true;
        const status = ["unsupported", "not_found", "no_public_preview"].includes(err.code) ? err.code : "error";
        values = { status, lastError: err.code, fetchedAt: now };
      }
    }
    out.push((await db.update(socialCompetitors).set(values).where(eq(socialCompetitors.id, c.id)).returning())[0]!);
  }
  if (igClient) {
    const account = await getAccount(projectId);
    if (account) {
      await db
        .update(socialAccounts)
        .set({ profile: sql`${socialAccounts.profile} || ${JSON.stringify({ businessDiscovery: !igUnsupported })}::jsonb` })
        .where(eq(socialAccounts.id, account.id));
    }
  }
  return out;
}
