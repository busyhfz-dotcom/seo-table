/**
 * Social alerts, delivered through the same notifications as the website
 * alerts (inbox, signed webhook, Telegram), each event once (dedupe keys):
 *
 *   follower_drop    followers fell by ≥ threshold % against 7 days earlier
 *   engagement_drop  ER (Instagram) or view rate (Telegram) of the last 10
 *                    settled posts is ≥ threshold % below the 10 before
 *   token_expiring   the Instagram token expires within threshold days (the
 *                    sync refreshes it 20 days ahead, so this means refreshing
 *                    failed and the owner must reconnect)
 *   publish_failed   a planned post could not be published
 */
import {
  alertRules,
  and,
  db,
  desc,
  eq,
  gte,
  projects,
  socialPosts,
  type AlertKind,
  type AlertRule,
  type Notification,
  type Project,
  type ScheduledPost,
  type SocialAccount,
} from "@seo/db";
import { notificationService } from "@seo/seo-data";
import { getAccount } from "./accounts.js";
import { followerSeries, postScore } from "./analytics.js";
import { socialReasonText } from "./reasons.js";
import { isoDay, mean } from "./text.js";

const DAY = 86_400_000;

async function rule(projectId: string, kind: AlertKind): Promise<AlertRule | null> {
  return (
    (await db
      .select()
      .from(alertRules)
      .where(and(eq(alertRules.projectId, projectId), eq(alertRules.kind, kind), eq(alertRules.enabled, true)))
      .limit(1))[0] ?? null
  );
}

async function project(projectId: string): Promise<Project> {
  return (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0]!;
}

function name(p: Project, a: SocialAccount | null): string {
  return a?.username ? `@${a.username}` : p.name;
}

export async function evaluateAfterSync(projectId: string, now = new Date()): Promise<Notification[]> {
  const account = await getAccount(projectId);
  if (!account || account.status === "NOT_CONNECTED") return [];
  const p = await project(projectId);
  const out: Notification[] = [];
  const link = `/social?project=${projectId}`;

  const drop = await rule(projectId, "follower_drop");
  if (drop) {
    const series = await followerSeries(projectId, isoDay(new Date(now.getTime() - 14 * DAY)), isoDay(now));
    const latest = series.at(-1);
    const weekAgo = latest ? [...series].reverse().find((s) => Date.parse(latest.date) - Date.parse(s.date) >= 7 * DAY) : undefined;
    if (latest && weekAgo && weekAgo.followers > 0) {
      const pct = ((weekAgo.followers - latest.followers) / weekAgo.followers) * 100;
      if (pct >= (drop.threshold ?? 5)) {
        const n = await notificationService.notify({
          orgId: p.orgId,
          projectId,
          rule: drop,
          now,
          event: {
            kind: "follower_drop",
            severity: "WARNING",
            title: { fa: `افت دنبال‌کننده در ${name(p, account)}`, en: `Followers dropped on ${name(p, account)}` },
            body: {
              fa: `از ${weekAgo.followers} به ${latest.followers} در یک هفته (${Math.round(pct)}٪ کمتر).`,
              en: `From ${weekAgo.followers} to ${latest.followers} in a week (${Math.round(pct)}% fewer).`,
            },
            link,
            data: { from: weekAgo, to: latest, percent: Math.round(pct * 10) / 10 },
            dedupeKey: `follower_drop:${projectId}:${latest.date}`,
          },
        });
        if (n) out.push(n);
      }
    }
  }

  const eng = await rule(projectId, "engagement_drop");
  if (eng) {
    const posts = await db
      .select()
      .from(socialPosts)
      .where(and(eq(socialPosts.projectId, projectId), gte(socialPosts.publishedAt, new Date(now.getTime() - 180 * DAY))))
      .orderBy(desc(socialPosts.publishedAt))
      .limit(60);
    const settled = posts.filter((x) => x.publishedAt && now.getTime() - x.publishedAt.getTime() > 2 * DAY);
    const scores = settled.map((x) => postScore(x, account)).filter((v): v is number => v !== null);
    if (scores.length >= 20) {
      const recent = mean(scores.slice(0, 10))!;
      const before = mean(scores.slice(10, 20))!;
      const pct = before > 0 ? ((before - recent) / before) * 100 : 0;
      if (pct >= (eng.threshold ?? 30)) {
        const metric = account.platform === "TELEGRAM" ? { fa: "بازدید", en: "Views" } : { fa: "نرخ تعامل", en: "Engagement rate" };
        const n = await notificationService.notify({
          orgId: p.orgId,
          projectId,
          rule: eng,
          now,
          event: {
            kind: "engagement_drop",
            severity: "WARNING",
            title: { fa: `افت ${metric.fa} در ${name(p, account)}`, en: `${metric.en} fell on ${name(p, account)}` },
            body: {
              fa: `${metric.fa} ۱۰ پست اخیر ${Math.round(pct)}٪ کمتر از ۱۰ پست قبل است.`,
              en: `${metric.en} of the last 10 posts is ${Math.round(pct)}% below the 10 before.`,
            },
            link,
            data: { recent, previous: before, percent: Math.round(pct * 10) / 10 },
            dedupeKey: `engagement_drop:${projectId}:${settled[0]!.externalId}`,
          },
        });
        if (n) out.push(n);
      }
    }
  }

  const tok = account.platform === "INSTAGRAM" ? await rule(projectId, "token_expiring") : null;
  if (tok && account.tokenExpiresAt) {
    const daysLeft = (account.tokenExpiresAt.getTime() - now.getTime()) / DAY;
    if (daysLeft <= (tok.threshold ?? 7)) {
      const days = Math.max(0, Math.floor(daysLeft));
      const n = await notificationService.notify({
        orgId: p.orgId,
        projectId,
        rule: tok,
        now,
        event: {
          kind: "token_expiring",
          severity: daysLeft <= 1 ? "SERIOUS" : "WARNING",
          title: { fa: `اتصال اینستاگرام ${name(p, account)} رو به انقضاست`, en: `Instagram connection for ${name(p, account)} is expiring` },
          body: {
            fa: `توکن تا ${days} روز دیگر منقضی می‌شود و تمدید خودکار آن ناموفق بود؛ حساب را دوباره وصل کنید.`,
            en: `The token expires in ${days} days and refreshing it failed; connect the account again.`,
          },
          link,
          data: { expiresAt: account.tokenExpiresAt.toISOString() },
          dedupeKey: `token_expiring:${projectId}:${isoDay(account.tokenExpiresAt)}`,
        },
      });
      if (n) out.push(n);
    }
  }
  return out;
}

export async function publishFailed(post: ScheduledPost, reason: string): Promise<Notification | null> {
  const r = await rule(post.projectId, "publish_failed");
  const p = await project(post.projectId);
  const account = await getAccount(post.projectId);
  const text = socialReasonText(reason)!;
  return notificationService.notify({
    orgId: p.orgId,
    projectId: post.projectId,
    // Without an enabled rule it is still an inbox notice: a post that did not
    // go out is never silent.
    rule: r,
    event: {
      kind: "publish_failed",
      severity: reason === "outcome_unknown" ? "SERIOUS" : "WARNING",
      title: { fa: `انتشار پست در ${name(p, account)} ناموفق بود`, en: `A post on ${name(p, account)} was not published` },
      body: text,
      link: `/social?project=${post.projectId}&post=${post.id}`,
      data: { postId: post.id, reason, attempts: post.attempts },
      dedupeKey: `publish_failed:${post.id}:${post.attempts}`,
    },
  });
}
