/**
 * Social analytics, computed from what the platforms reported and nothing
 * else. Every figure names the formula it comes from:
 *
 *   interactions(post)   Instagram total_interactions when reported, otherwise
 *                        likes + comments + saves + shares (whichever exist)
 *   ER by reach          interactions ÷ reach × 100 (per post; averaged)
 *   ER by followers      interactions ÷ current followers × 100
 *   view rate (Telegram) views ÷ current members × 100; views come from the
 *                        public preview and are rounded by Telegram
 *   follower growth      last − first follower count in the range (daily rows,
 *                        the platform API preferred over the public preview)
 *   best times           median of the post metric (ER by reach, or views) per
 *                        hour and weekday of publishing, in the profile's
 *                        timezone, over buckets with at least two posts
 *   hashtag lift         a hashtag's average post metric ÷ the average of all
 *                        posts in the range (1.0 = no difference), 2+ posts
 */
import { and, asc, db, desc, eq, gte, lte, socialMetricsDaily, socialPosts, type SocialAccount, type SocialPost } from "@seo/db";
import { mean, median } from "./text.js";

export const DEFAULT_TIMEZONE = "Asia/Tehran";

export function interactionsOf(p: Pick<SocialPost, "metrics">): number | null {
  const m = p.metrics;
  if (typeof m.interactions === "number") return m.interactions;
  const parts = [m.likes, m.comments, m.saves, m.shares].filter((v): v is number => typeof v === "number");
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

/** Percent, or null when a denominator is missing. */
export function erByReach(p: Pick<SocialPost, "metrics">): number | null {
  const i = interactionsOf(p);
  const reach = p.metrics.reach;
  return i !== null && reach && reach > 0 ? (i / reach) * 100 : null;
}

export function erByFollowers(p: Pick<SocialPost, "metrics">, followers: number | null): number | null {
  const i = interactionsOf(p);
  return i !== null && followers && followers > 0 ? (i / followers) * 100 : null;
}

export function viewRate(p: Pick<SocialPost, "metrics">, members: number | null): number | null {
  const v = p.metrics.views;
  return typeof v === "number" && members && members > 0 ? (v / members) * 100 : null;
}

/** The number a post is judged by on its platform: ER by reach (else by followers) on Instagram, views on Telegram. */
export function postScore(p: SocialPost, account: Pick<SocialAccount, "platform" | "followers">): number | null {
  if (account.platform === "TELEGRAM") return typeof p.metrics.views === "number" ? p.metrics.views : null;
  return erByReach(p) ?? erByFollowers(p, account.followers);
}

function localParts(d: Date, timeZone: string): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  return { hour, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd) };
}

export type TimeBucket = { key: number; posts: number; median: number };

export function bestTimes(posts: SocialPost[], account: Pick<SocialAccount, "platform" | "followers">, timeZone: string) {
  const byHour = new Map<number, number[]>();
  const byWeekday = new Map<number, number[]>();
  for (const p of posts) {
    const score = postScore(p, account);
    if (score === null || !p.publishedAt) continue;
    const { hour, weekday } = localParts(p.publishedAt, timeZone);
    (byHour.get(hour) ?? byHour.set(hour, []).get(hour)!).push(score);
    (byWeekday.get(weekday) ?? byWeekday.set(weekday, []).get(weekday)!).push(score);
  }
  const buckets = (m: Map<number, number[]>): TimeBucket[] =>
    [...m.entries()]
      .filter(([, v]) => v.length >= 2)
      .map(([key, v]) => ({ key, posts: v.length, median: round(median(v)!) }))
      .sort((a, b) => b.median - a.median);
  return { timeZone, hours: buckets(byHour), weekdays: buckets(byWeekday) };
}

export function hourOf(d: Date, timeZone: string): number {
  return localParts(d, timeZone).hour;
}

export function hashtagPerformance(posts: SocialPost[], account: Pick<SocialAccount, "platform" | "followers">) {
  const scored = posts.map((p) => ({ p, s: postScore(p, account) })).filter((x): x is { p: SocialPost; s: number } => x.s !== null);
  const overall = mean(scored.map((x) => x.s));
  const tags = new Map<string, number[]>();
  for (const { p, s } of scored) for (const t of p.hashtags) (tags.get(t) ?? tags.set(t, []).get(t)!).push(s);
  return [...tags.entries()]
    .filter(([, v]) => v.length >= 2)
    .map(([tag, v]) => {
      const avg = mean(v)!;
      return { tag, posts: v.length, average: round(avg), lift: overall ? round(avg / overall) : null };
    })
    .sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0))
    .slice(0, 30);
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export async function postsInRange(projectId: string, from: Date, to: Date, limit = 500): Promise<SocialPost[]> {
  return db
    .select()
    .from(socialPosts)
    .where(and(eq(socialPosts.projectId, projectId), gte(socialPosts.publishedAt, from), lte(socialPosts.publishedAt, to)))
    .orderBy(desc(socialPosts.publishedAt))
    .limit(limit);
}

/** Daily follower counts, one per day: the platform API's figure when there is one, else the public preview's. */
export async function followerSeries(projectId: string, from: string, to: string): Promise<Array<{ date: string; followers: number; source: string }>> {
  const rows = await db
    .select()
    .from(socialMetricsDaily)
    .where(and(eq(socialMetricsDaily.projectId, projectId), gte(socialMetricsDaily.date, from), lte(socialMetricsDaily.date, to)))
    .orderBy(asc(socialMetricsDaily.date));
  const byDate = new Map<string, { followers: number; source: string }>();
  for (const r of rows) {
    if (r.followers === null) continue;
    const existing = byDate.get(r.date);
    if (!existing || (existing.source !== "api" && r.source === "api")) byDate.set(r.date, { followers: r.followers, source: r.source });
  }
  return [...byDate.entries()].map(([date, v]) => ({ date, ...v }));
}

export type Analytics = Awaited<ReturnType<typeof analytics>>;

export async function analytics(account: SocialAccount, range: { from: string; to: string }) {
  const from = new Date(`${range.from}T00:00:00Z`);
  const to = new Date(`${range.to}T23:59:59Z`);
  const tz = account.settings.timezone ?? DEFAULT_TIMEZONE;
  const [posts, series, daily] = await Promise.all([
    postsInRange(account.projectId, from, to),
    followerSeries(account.projectId, range.from, range.to),
    db
      .select()
      .from(socialMetricsDaily)
      .where(
        and(
          eq(socialMetricsDaily.projectId, account.projectId),
          eq(socialMetricsDaily.source, "api"),
          gte(socialMetricsDaily.date, range.from),
          lte(socialMetricsDaily.date, range.to),
        ),
      )
      .orderBy(asc(socialMetricsDaily.date)),
  ]);
  const first = series[0];
  const last = series.at(-1);
  const followers = account.followers;
  const isTg = account.platform === "TELEGRAM";

  const perPost = posts.map((p) => ({
    id: p.id,
    externalId: p.externalId,
    permalink: p.permalink,
    type: p.type,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    caption: p.caption?.slice(0, 200) ?? null,
    hashtags: p.hashtags,
    metrics: p.metrics,
    source: p.source,
    interactions: isTg ? null : interactionsOf(p),
    erByReach: isTg ? null : nullableRound(erByReach(p)),
    erByFollowers: isTg ? null : nullableRound(erByFollowers(p, followers)),
    viewRate: isTg ? nullableRound(viewRate(p, followers)) : null,
  }));
  const avg = (vals: Array<number | null>) => nullableRound(mean(vals.filter((v): v is number => v !== null)));
  const days = Math.max(1, (to.getTime() - from.getTime()) / 86_400_000);

  return {
    platform: account.platform,
    range,
    timeZone: tz,
    followers: {
      current: followers,
      series,
      net: first && last ? last.followers - first.followers : null,
      percent: first && last && first.followers > 0 ? round(((last.followers - first.followers) / first.followers) * 100) : null,
    },
    daily: daily.map((d) => ({ date: d.date, reach: d.reach, views: d.views, engagement: d.engagement })),
    posts: {
      count: posts.length,
      perWeek: round((posts.length / days) * 7, 1),
      byType: countBy(posts.map((p) => p.type)),
    },
    engagement: isTg
      ? { averageViews: avg(posts.map((p) => (typeof p.metrics.views === "number" ? p.metrics.views : null))), averageViewRate: avg(perPost.map((p) => p.viewRate)) }
      : { averageErByReach: avg(perPost.map((p) => p.erByReach)), averageErByFollowers: avg(perPost.map((p) => p.erByFollowers)) },
    topPosts: [...perPost]
      .sort((a, b) => (isTg ? (b.metrics.views ?? -1) - (a.metrics.views ?? -1) : (b.interactions ?? -1) - (a.interactions ?? -1)))
      .slice(0, 10),
    recentPosts: perPost.slice(0, 50),
    bestTimes: bestTimes(posts, account, tz),
    hashtags: hashtagPerformance(posts, account),
    formulas: FORMULAS[account.platform],
    sources: {
      followers: series.some((s) => s.source === "api") ? "api" : series.length ? "public_preview" : null,
      views: isTg ? "public_preview" : "api",
    },
  };
}

function nullableRound(v: number | null): number | null {
  return v === null ? null : round(v);
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

const FORMULAS = {
  INSTAGRAM: {
    erByReach: { fa: "نرخ تعامل بر پایهٔ دسترسی = تعامل‌ها (لایک + کامنت + ذخیره + اشتراک) ÷ دسترسی × ۱۰۰", en: "ER by reach = interactions (likes + comments + saves + shares) ÷ reach × 100" },
    erByFollowers: { fa: "نرخ تعامل بر پایهٔ دنبال‌کننده = تعامل‌ها ÷ تعداد فعلی دنبال‌کنندگان × ۱۰۰", en: "ER by followers = interactions ÷ current followers × 100" },
    bestTimes: { fa: "میانهٔ نرخ تعامل پست‌ها در هر ساعت/روز انتشار (حداقل ۲ پست)", en: "Median post ER per publishing hour/weekday (2+ posts per bucket)" },
    hashtagLift: { fa: "میانگین عملکرد پست‌های دارای هشتگ ÷ میانگین همهٔ پست‌ها", en: "Average of posts with the hashtag ÷ average of all posts" },
  },
  TELEGRAM: {
    viewRate: { fa: "نرخ بازدید = بازدید پست ÷ تعداد فعلی اعضا × ۱۰۰ (بازدیدها از پیش‌نمایش عمومی تلگرام و گردشده)", en: "View rate = post views ÷ current members × 100 (views from Telegram's public preview, rounded)" },
    bestTimes: { fa: "میانهٔ بازدید پست‌ها در هر ساعت/روز انتشار (حداقل ۲ پست)", en: "Median post views per publishing hour/weekday (2+ posts per bucket)" },
    hashtagLift: { fa: "میانگین بازدید پست‌های دارای هشتگ ÷ میانگین همهٔ پست‌ها", en: "Average views of posts with the hashtag ÷ average of all posts" },
  },
} as const;
