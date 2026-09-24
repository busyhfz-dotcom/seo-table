/**
 * The social audit: rules over the profile, its recent posts and daily
 * metrics, with the reason and a copy-ready suggestion in both languages.
 *
 * Findings are stored exactly like a website scan's (an audit_runs row, then
 * seo_issues + the append-only issue_occurrences through persistFindings), so
 * history, ignore, and the approval queue work the same. Where the platform
 * lets us write (Telegram title and description, with the can_change_info
 * right) a finding carries a SENSITIVE fix proposal that waits for a person;
 * where it does not (Instagram name, bio, website; a Telegram @username) the
 * finding is `manual` and its suggestion is text to paste in the app.
 *
 * Assumptions a rule depends on are written in its `why`, not hidden:
 * thresholds are rules of thumb, not platform facts.
 */
import {
  auditRuns,
  and,
  db,
  desc,
  eq,
  fixProposals,
  gte,
  inArray,
  projects,
  seoIssues,
  socialMetricsDaily,
  socialPosts,
  type LocalizedText,
  type Project,
  type Severity,
  type SocialAccount,
  type SocialPost,
} from "@seo/db";
import { groupFindings, issueService, proposalService, type Actor, type Finding } from "@seo/core";
import { TELEGRAM_DESCRIPTION_MAX, TELEGRAM_TITLE_MAX, telegramTarget } from "@seo/connectors";
import { getAccount } from "./accounts.js";
import { DEFAULT_TIMEZONE, bestTimes, hourOf, postScore } from "./analytics.js";
import { charLength, containsKeyword, fit, hasCallToAction, hasLink, mean, median } from "./text.js";

export type SocialRule = {
  id: string;
  platform: "INSTAGRAM" | "TELEGRAM";
  category: string;
  title: LocalizedText;
  why: LocalizedText;
};

export type Suggestion = {
  field: "name" | "bio" | "website" | "title" | "description" | "username" | "alt_text" | "caption" | "posting";
  /** Text to paste or apply; null for advice without a single value. */
  value: string | null;
};

export type SocialFinding = {
  ruleId: string;
  severity: Severity;
  detail: LocalizedText;
  /** True when the platform's API cannot apply it: the owner changes it in the app. */
  manual: boolean;
  suggestion: Suggestion | null;
  evidence: Record<string, unknown>;
};

const r = (
  id: string,
  platform: SocialRule["platform"],
  category: string,
  title: LocalizedText,
  why: LocalizedText,
): SocialRule => ({ id, platform, category, title, why });

export const SOCIAL_RULES: SocialRule[] = [
  r("social.ig.keywords_missing", "INSTAGRAM", "profile", { fa: "کلیدواژه‌های هدف تعیین نشده", en: "No target keywords set" }, {
    fa: "بدون کلیدواژهٔ هدف نمی‌توان سنجید که نام، بیو و کپشن‌ها برای جست‌وجوی داخل اینستاگرام بهینه‌اند. در تنظیمات، ۱ تا ۵ عبارتی را که مخاطب جست‌وجو می‌کند وارد کنید.",
    en: "Without target keywords the audit cannot tell whether the name, bio and captions match what people search for inside Instagram. Add 1–5 phrases in the settings.",
  }),
  r("social.ig.name_keyword", "INSTAGRAM", "profile", { fa: "کلیدواژه در فیلد «نام» نیست", en: "Name field lacks a keyword" }, {
    fa: "جست‌وجوی اینستاگرام علاوه بر نام کاربری، فیلد «نام» را هم می‌خواند؛ آوردن کلیدواژهٔ اصلی در آن، پیدا شدن صفحه را آسان‌تر می‌کند. این فیلد از طریق API قابل تغییر نیست و باید در اپ ویرایش شود.",
    en: "Instagram search reads the Name field as well as the username; the main keyword there makes the page easier to find. The API cannot change it: edit it in the app.",
  }),
  r("social.ig.bio_keyword", "INSTAGRAM", "profile", { fa: "کلیدواژه در بیو نیست", en: "Bio lacks a keyword" }, {
    fa: "بیو اولین توضیحی است که بازدیدکننده می‌خواند و در نتایج جست‌وجو هم دیده می‌شود. API اجازهٔ ویرایش بیو را نمی‌دهد؛ متن پیشنهادی را در اپ جایگزین کنید.",
    en: "The bio is the first description a visitor reads and it shows in search results. The API cannot edit it; paste the suggested text in the app.",
  }),
  r("social.ig.bio_cta", "INSTAGRAM", "profile", { fa: "بیو دعوت به اقدام ندارد", en: "Bio has no call to action" }, {
    fa: "یک دعوت به اقدام روشن (سفارش در دایرکت، لینک زیر، تماس) بازدید پروفایل را به اقدام تبدیل می‌کند. تشخیص خودکار است و ممکن است دقیق نباشد.",
    en: "A clear call to action (order via DM, link below, call) turns profile visits into action. Detection is heuristic.",
  }),
  r("social.ig.bio_link", "INSTAGRAM", "profile", { fa: "لینک وب‌سایت در پروفایل نیست", en: "No website link on the profile" }, {
    fa: "لینک پروفایل تنها لینک قابل کلیک ثابت اینستاگرام است. از طریق API قابل تنظیم نیست؛ در اپ اضافه کنید.",
    en: "The profile link is Instagram's only permanent clickable link. The API cannot set it; add it in the app.",
  }),
  r("social.ig.alt_text", "INSTAGRAM", "accessibility", { fa: "متن جایگزین تصاویر کم است", en: "Low alt-text coverage" }, {
    fa: "متن جایگزین به نابینایان و به درک محتوای تصویر توسط اینستاگرام کمک می‌کند. پست‌های قبلی را در اپ ویرایش کنید؛ پست‌هایی که از برنامه‌ریز پنل منتشر شوند متن جایگزین را خودکار دارند.",
    en: "Alt text helps blind visitors and Instagram's understanding of images. Edit past posts in the app; posts published from the panel's planner carry it automatically.",
  }),
  r("social.ig.caption_keywords", "INSTAGRAM", "content", { fa: "کپشن‌ها کلیدواژه ندارند", en: "Captions rarely use keywords" }, {
    fa: "اینستاگرام کپشن را برای جست‌وجو و پیشنهاد محتوا می‌خواند. فرض: دست‌کم یک‌سوم پست‌ها باید کلیدواژهٔ هدف را داشته باشند.",
    en: "Instagram reads captions for search and recommendations. Assumption: at least a third of posts should mention a target keyword.",
  }),
  r("social.ig.hashtags", "INSTAGRAM", "content", { fa: "تعداد هشتگ‌ها مناسب نیست", en: "Hashtag count is off" }, {
    fa: "راهنمای خود اینستاگرام ۳ تا ۵ هشتگ مرتبط است؛ هشتگ بیشتر کمکی نمی‌کند و ممکن است اسپم به نظر برسد، و نداشتن هشتگ یک راه دیده شدن را از دست می‌دهد.",
    en: "Instagram's own guidance is 3–5 relevant hashtags; more adds nothing and can look spammy, none gives up one way to be discovered.",
  }),
  r("social.ig.cadence", "INSTAGRAM", "activity", { fa: "انتشار نامنظم یا کم", en: "Posting is infrequent" }, {
    fa: "فرض: حداقل دو پست در هفته برای ماندن در فید دنبال‌کنندگان. سکوت دو هفته‌ای دسترسی را به‌وضوح کم می‌کند.",
    en: "Assumption: at least two posts a week to stay in followers' feeds. Two silent weeks visibly reduce reach.",
  }),
  r("social.ig.engagement_trend", "INSTAGRAM", "performance", { fa: "افت نرخ تعامل", en: "Engagement is falling" }, {
    fa: "نرخ تعامل ۱۰ پست اخیر با ۱۰ پست قبل مقایسه شده است (پست‌های کمتر از دو روز کنار گذاشته شده‌اند چون هنوز آمارشان کامل نیست).",
    en: "Engagement of the last 10 posts compared with the 10 before (posts under two days old are left out: their numbers are still growing).",
  }),
  r("social.ig.best_hours", "INSTAGRAM", "activity", { fa: "انتشار خارج از بهترین ساعت‌ها", en: "Posting outside your best hours" }, {
    fa: "بر اساس عملکرد پست‌های خود شما (میانهٔ نرخ تعامل در هر ساعت)، نه یک جدول عمومی.",
    en: "Based on your own posts' performance (median engagement per hour), not a generic table.",
  }),
  r("social.ig.reels_share", "INSTAGRAM", "content", { fa: "سهم ریلز کم است", en: "Few reels" }, {
    fa: "ریلز بیشترین نمایش به غیردنبال‌کنندگان را دارد. فرض: دست‌کم ۲۰٪ پست‌ها ریلز باشد.",
    en: "Reels get the most reach beyond followers. Assumption: at least 20% of posts should be reels.",
  }),
  r("social.tg.keywords_missing", "TELEGRAM", "profile", { fa: "کلیدواژه‌های هدف تعیین نشده", en: "No target keywords set" }, {
    fa: "جست‌وجوی سراسری تلگرام عنوان و نام کاربری کانال را می‌خواند. بدون کلیدواژهٔ هدف نمی‌توان عنوان و توضیحات را سنجید.",
    en: "Telegram's global search reads the channel title and username. Without target keywords the title and description cannot be judged.",
  }),
  r("social.tg.title_keyword", "TELEGRAM", "profile", { fa: "کلیدواژه در عنوان کانال نیست", en: "Channel title lacks a keyword" }, {
    fa: "عنوان کانال مهم‌ترین متنی است که جست‌وجوی تلگرام می‌بیند. تغییر عنوان از طریق ربات و پس از تأیید شما انجام می‌شود و قابل بازگشت است.",
    en: "The channel title is what Telegram search weighs most. The change is applied by the bot after your approval, and can be rolled back.",
  }),
  r("social.tg.title_length", "TELEGRAM", "profile", { fa: "عنوان کانال طولانی است", en: "Channel title is long" }, {
    fa: "فهرست گفتگوها حدود ۲۵ تا ۳۵ نویسه از عنوان را نشان می‌دهد (بسته به دستگاه)؛ بخش مهم را اول بیاورید.",
    en: "Chat lists show about 25–35 characters of a title (depending on the device); put what matters first.",
  }),
  r("social.tg.description_missing", "TELEGRAM", "profile", { fa: "کانال توضیحات ندارد", en: "Channel has no description" }, {
    fa: "توضیحات در صفحهٔ معرفی کانال و پیش‌نمایش لینک دیده می‌شود و به تصمیم عضویت کمک می‌کند.",
    en: "The description shows on the channel's info page and link previews, and helps people decide to join.",
  }),
  r("social.tg.description_keyword", "TELEGRAM", "profile", { fa: "کلیدواژه در توضیحات نیست", en: "Description lacks a keyword" }, {
    fa: "توضیحاتی که موضوع کانال را با همان کلمات جست‌وجوی مخاطب بگوید، هم در جست‌وجو و هم در تصمیم عضویت اثر دارد.",
    en: "A description that names the topic in the words people search for helps both search and the decision to join.",
  }),
  r("social.tg.description_cta", "TELEGRAM", "profile", { fa: "توضیحات لینک یا دعوت به اقدام ندارد", en: "Description has no link or call to action" }, {
    fa: "لینک سایت یا آیدی پشتیبانی و یک دعوت به اقدام، بازدید را به تماس و خرید تبدیل می‌کند.",
    en: "A site link or support @username and a call to action turn visits into contact and sales.",
  }),
  r("social.tg.public_username", "TELEGRAM", "profile", { fa: "کانال نام کاربری عمومی ندارد", en: "Channel has no public username" }, {
    fa: "کانال خصوصی در جست‌وجوی تلگرام پیدا نمی‌شود و پیش‌نمایش وب ندارد. ربات نمی‌تواند نام کاربری را تنظیم کند؛ در تنظیمات کانال اضافه کنید.",
    en: "A private channel is not found by Telegram search and has no web preview. A bot cannot set the username; add it in the channel's settings.",
  }),
  r("social.tg.cadence", "TELEGRAM", "activity", { fa: "انتشار نامنظم یا کم", en: "Posting is infrequent" }, {
    fa: "فرض: حداقل دو پست در هفته برای فعال ماندن کانال در ذهن اعضا.",
    en: "Assumption: at least two posts a week keep a channel on members' minds.",
  }),
  r("social.tg.post_length", "TELEGRAM", "content", { fa: "طول پست‌ها مناسب نیست", en: "Post length is off" }, {
    fa: "پست‌های بسیار بلند در موبایل کمتر تا آخر خوانده می‌شوند و پست‌های خیلی کوتاه بی‌زمینه‌اند. فرض: میانهٔ طول بین ۴۰ تا ۱۵۰۰ نویسه.",
    en: "Very long posts are rarely read to the end on phones; very short ones lack context. Assumption: median length between 40 and 1,500 characters.",
  }),
  r("social.tg.formatting", "TELEGRAM", "content", { fa: "پست‌های بلند قالب‌بندی ندارند", en: "Long posts are unformatted" }, {
    fa: "تیتر پررنگ، پاراگراف‌بندی و لینک، پست بلند را خواناتر می‌کند.",
    en: "A bold heading, paragraphs and links make a long post readable.",
  }),
  r("social.tg.hashtags", "TELEGRAM", "content", { fa: "هشتگ زیاد", en: "Too many hashtags" }, {
    fa: "در تلگرام هشتگ برای دسته‌بندی درون کانال است؛ بیش از ۵ هشتگ در پست شلوغی ایجاد می‌کند.",
    en: "In Telegram hashtags categorise posts inside the channel; more than 5 per post is clutter.",
  }),
  r("social.tg.view_rate", "TELEGRAM", "performance", { fa: "نرخ بازدید کم یا رو به افت", en: "View rate is low or falling" }, {
    fa: "نرخ بازدید = بازدید ÷ اعضا. بازدیدها از پیش‌نمایش عمومی تلگرام خوانده می‌شود و گرد شده است. فرض: زیر ۱۰٪ کم است؛ افت بیش از ۳۰٪ نسبت به ۱۰ پست قبل هشدار است.",
    en: "View rate = views ÷ members. Views come from Telegram's public preview and are rounded. Assumption: under 10% is low; a drop over 30% against the previous 10 posts is a warning.",
  }),
  r("social.tg.pinned", "TELEGRAM", "profile", { fa: "پیام سنجاق‌شده ندارد", en: "No pinned message" }, {
    fa: "یک پیام سنجاق‌شده (معرفی، قوانین، لینک‌ها) اولین چیزی است که عضو جدید می‌بیند. از برنامه‌ریز می‌توانید پیامی را سنجاق کنید.",
    en: "A pinned message (intro, rules, links) is the first thing a new member sees. You can pin one from the planner.",
  }),
  r("social.tg.best_hours", "TELEGRAM", "activity", { fa: "انتشار خارج از بهترین ساعت‌ها", en: "Posting outside your best hours" }, {
    fa: "بر اساس بازدید پست‌های خود کانال (میانه در هر ساعت)، نه یک جدول عمومی.",
    en: "Based on your channel's own post views (median per hour), not a generic table.",
  }),
];

export function socialRule(id: string): SocialRule | undefined {
  return SOCIAL_RULES.find((x) => x.id === id);
}

const WEIGHT: Record<Severity, number> = { CRITICAL: 20, SERIOUS: 12, WARNING: 6, INFO: 2 };

/** 100 minus a weight per finding by severity, floored at 0. */
export function socialScore(findings: Pick<SocialFinding, "severity">[]): number {
  return Math.max(0, 100 - findings.reduce((s, f) => s + WEIGHT[f.severity], 0));
}

const DAY = 86_400_000;
type Ctx = { account: SocialAccount; posts: SocialPost[]; now: Date; locale: "fa" | "en" };

function joinList(items: string[], locale: "fa" | "en"): string {
  return items.join(locale === "fa" ? "، " : ", ");
}

function missingKeywords(text: string | null | undefined, keywords: string[]): string[] {
  return keywords.filter((k) => !containsKeyword(text, k));
}

/** Suggested profile text: keywords missing from it first, then the text, then the CTA and link if absent. Cut to the limit. */
function composeDescription(current: string | null, ctx: Ctx, max: number): string {
  const s = ctx.account.settings;
  const lines: string[] = [];
  const missing = missingKeywords(current, s.keywords ?? []).slice(0, 3);
  if (missing.length) lines.push(joinList(missing, ctx.locale));
  if (current?.trim()) lines.push(current.trim());
  if (s.cta && !hasCallToAction(current)) lines.push(s.cta);
  if (s.link && !hasLink(current)) lines.push(s.link);
  // The link is what the owner asked for, so it is kept whole when the rest must be cut.
  const link = s.link && !hasLink(current) ? s.link : null;
  const body = lines.filter((l) => l !== link).join("\n");
  if (!link) return fit(body, max);
  return `${fit(body, Math.max(0, max - [...link].length - 1))}\n${link}`;
}

function settledPosts(posts: SocialPost[], now: Date): SocialPost[] {
  return posts.filter((p) => p.publishedAt && now.getTime() - p.publishedAt.getTime() > 2 * DAY);
}

function cadence(ctx: Ctx, ruleId: string): SocialFinding[] {
  const dated = ctx.posts.filter((p) => p.publishedAt);
  const last = dated[0]?.publishedAt;
  const in30 = dated.filter((p) => ctx.now.getTime() - p.publishedAt!.getTime() <= 30 * DAY).length;
  if (!last) return [];
  const idle = Math.floor((ctx.now.getTime() - last.getTime()) / DAY);
  if (idle >= 14) {
    return [{
      ruleId,
      severity: "SERIOUS",
      manual: false,
      suggestion: { field: "posting", value: null },
      detail: { fa: `${idle} روز است پستی منتشر نشده.`, en: `No post for ${idle} days.` },
      evidence: { daysSinceLastPost: idle, postsLast30Days: in30 },
    }];
  }
  if (in30 < 8) {
    return [{
      ruleId,
      severity: "WARNING",
      manual: false,
      suggestion: { field: "posting", value: null },
      detail: { fa: `${in30} پست در ۳۰ روز اخیر (پیشنهاد: دست‌کم ۸).`, en: `${in30} posts in the last 30 days (suggested: at least 8).` },
      evidence: { daysSinceLastPost: idle, postsLast30Days: in30 },
    }];
  }
  return [];
}

function trend(ctx: Ctx, ruleId: string, metric: (p: SocialPost) => number | null, label: LocalizedText): SocialFinding[] {
  const values = settledPosts(ctx.posts, ctx.now).map(metric).filter((v): v is number => v !== null);
  if (values.length < 20) return [];
  const recent = mean(values.slice(0, 10))!;
  const before = mean(values.slice(10, 20))!;
  if (before <= 0) return [];
  const change = ((recent - before) / before) * 100;
  if (change > -30) return [];
  const pct = Math.round(-change);
  return [{
    ruleId,
    severity: "WARNING",
    manual: false,
    suggestion: null,
    detail: { fa: `${label.fa} ۱۰ پست اخیر ${pct}٪ کمتر از ۱۰ پست قبل است.`, en: `${label.en} of the last 10 posts is ${pct}% below the 10 before.` },
    evidence: { recent: round2(recent), previous: round2(before), changePercent: round2(change) },
  }];
}

function bestHoursFinding(ctx: Ctx, ruleId: string): SocialFinding[] {
  if (ctx.posts.length < 15) return [];
  const tz = ctx.account.settings.timezone ?? DEFAULT_TIMEZONE;
  const bt = bestTimes(ctx.posts, ctx.account, tz);
  if (bt.hours.length < 4) return [];
  const top = bt.hours.slice(0, 3).map((h) => h.key);
  const recent = ctx.posts.filter((p) => p.publishedAt).slice(0, 20);
  const inTop = recent.filter((p) => top.includes(hourOf(p.publishedAt!, tz))).length;
  if (inTop / recent.length >= 0.3) return [];
  const hours = top.map((h) => `${String(h).padStart(2, "0")}:00`);
  return [{
    ruleId,
    severity: "INFO",
    manual: false,
    suggestion: { field: "posting", value: hours.join(", ") },
    detail: {
      fa: `بهترین ساعت‌های شما ${joinList(hours, "fa")} (${tz}) است، اما فقط ${inTop} از ${recent.length} پست اخیر در این ساعت‌ها منتشر شده.`,
      en: `Your best hours are ${hours.join(", ")} (${tz}), but only ${inTop} of the last ${recent.length} posts went out then.`,
    },
    evidence: { topHours: top, timeZone: tz, recentInTopHours: inTop, recent: recent.length },
  }];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------- Instagram rules

function instagramFindings(ctx: Ctx): SocialFinding[] {
  const a = ctx.account;
  const out: SocialFinding[] = [];
  const keywords = a.settings.keywords ?? [];
  const posts = ctx.posts.slice(0, 30);

  if (!keywords.length) {
    out.push({
      ruleId: "social.ig.keywords_missing",
      severity: "INFO",
      manual: false,
      suggestion: null,
      detail: { fa: "کلیدواژه‌های هدف را در تنظیمات وارد کنید.", en: "Add target keywords in the settings." },
      evidence: {},
    });
  } else {
    if (missingKeywords(a.displayName, keywords).length === keywords.length) {
      const value = fit(a.displayName ? `${a.displayName} | ${keywords[0]}` : keywords[0]!, 64);
      out.push({
        ruleId: "social.ig.name_keyword",
        severity: "WARNING",
        manual: true,
        suggestion: { field: "name", value },
        detail: { fa: `فیلد نام («${a.displayName ?? ""}») هیچ‌یک از کلیدواژه‌ها را ندارد.`, en: `The name field (“${a.displayName ?? ""}”) has none of the keywords.` },
        evidence: { name: a.displayName, keywords },
      });
    }
    if (missingKeywords(a.bio, keywords).length === keywords.length) {
      out.push({
        ruleId: "social.ig.bio_keyword",
        severity: "WARNING",
        manual: true,
        suggestion: { field: "bio", value: composeDescription(a.bio, ctx, 150) },
        detail: { fa: "بیو هیچ‌یک از کلیدواژه‌های هدف را ندارد.", en: "The bio has none of the target keywords." },
        evidence: { bio: a.bio, keywords },
      });
    }
    const withKw = posts.filter((p) => keywords.some((k) => containsKeyword(p.caption, k))).length;
    if (posts.length >= 6 && withKw / posts.length < 1 / 3) {
      out.push({
        ruleId: "social.ig.caption_keywords",
        severity: "WARNING",
        manual: false,
        suggestion: { field: "caption", value: null },
        detail: {
          fa: `فقط ${withKw} از ${posts.length} کپشن اخیر کلیدواژهٔ هدف دارد.`,
          en: `Only ${withKw} of the last ${posts.length} captions mention a target keyword.`,
        },
        evidence: { withKeyword: withKw, posts: posts.length },
      });
    }
  }
  if (!hasCallToAction(a.bio)) {
    out.push({
      ruleId: "social.ig.bio_cta",
      severity: "INFO",
      manual: true,
      suggestion: { field: "bio", value: a.settings.cta ? composeDescription(a.bio, ctx, 150) : null },
      detail: { fa: "در بیو دعوت به اقدامی پیدا نشد.", en: "No call to action was found in the bio." },
      evidence: { bio: a.bio },
    });
  }
  if (!a.website) {
    out.push({
      ruleId: "social.ig.bio_link",
      severity: "WARNING",
      manual: true,
      suggestion: { field: "website", value: a.settings.link ?? null },
      detail: { fa: "پروفایل لینک وب‌سایت ندارد.", en: "The profile has no website link." },
      evidence: {},
    });
  }

  // Alt text: only posts for which the API reported alt text at all.
  const withAlt = posts.filter((p) => p.altTexts !== null && (p.type === "image" || p.type === "carousel"));
  const images = withAlt.flatMap((p) => p.altTexts ?? []);
  if (images.length >= 3) {
    const covered = images.filter((t) => t && t.trim()).length;
    const share = covered / images.length;
    if (share < 0.5) {
      out.push({
        ruleId: "social.ig.alt_text",
        severity: share === 0 ? "WARNING" : "INFO",
        manual: true,
        suggestion: { field: "alt_text", value: null },
        detail: {
          fa: `${covered} از ${images.length} تصویر اخیر متن جایگزین دارد.`,
          en: `${covered} of the last ${images.length} images have alt text.`,
        },
        evidence: { covered, images: images.length },
      });
    }
  }

  if (posts.length >= 6) {
    const avgTags = mean(posts.map((p) => p.hashtags.length))!;
    const none = posts.filter((p) => p.hashtags.length === 0).length;
    if (avgTags > 5) {
      out.push({
        ruleId: "social.ig.hashtags",
        severity: "INFO",
        manual: false,
        suggestion: { field: "caption", value: null },
        detail: { fa: `میانگین ${round2(avgTags)} هشتگ در هر پست (پیشنهاد: ۳ تا ۵).`, en: `An average of ${round2(avgTags)} hashtags per post (suggested: 3–5).` },
        evidence: { averageHashtags: round2(avgTags) },
      });
    } else if (none / posts.length > 0.8) {
      out.push({
        ruleId: "social.ig.hashtags",
        severity: "INFO",
        manual: false,
        suggestion: { field: "caption", value: null },
        detail: { fa: `${none} از ${posts.length} پست اخیر هشتگ ندارد (پیشنهاد: ۳ تا ۵ هشتگ مرتبط).`, en: `${none} of the last ${posts.length} posts have no hashtag (suggested: 3–5 relevant ones).` },
        evidence: { withoutHashtags: none },
      });
    }
    const reels = posts.filter((p) => p.type === "reel").length;
    if (reels / posts.length < 0.2) {
      out.push({
        ruleId: "social.ig.reels_share",
        severity: "INFO",
        manual: false,
        suggestion: null,
        detail: { fa: `${reels} از ${posts.length} پست اخیر ریلز است.`, en: `${reels} of the last ${posts.length} posts are reels.` },
        evidence: { reels, posts: posts.length },
      });
    }
  }

  out.push(...cadence(ctx, "social.ig.cadence"));
  out.push(...trend(ctx, "social.ig.engagement_trend", (p) => postScore(p, a), { fa: "نرخ تعامل", en: "Engagement rate" }));
  out.push(...bestHoursFinding(ctx, "social.ig.best_hours"));
  return out;
}

// ---------------------------------------------------------------- Telegram rules

function telegramFindings(ctx: Ctx): SocialFinding[] {
  const a = ctx.account;
  const out: SocialFinding[] = [];
  const keywords = a.settings.keywords ?? [];
  const title = a.displayName ?? "";
  const description = a.bio ?? "";
  const canChange = Boolean(a.profile.rights?.can_change_info);

  if (!keywords.length) {
    out.push({
      ruleId: "social.tg.keywords_missing",
      severity: "INFO",
      manual: false,
      suggestion: null,
      detail: { fa: "کلیدواژه‌های هدف را در تنظیمات وارد کنید.", en: "Add target keywords in the settings." },
      evidence: {},
    });
  } else if (missingKeywords(title, keywords).length === keywords.length) {
    out.push({
      ruleId: "social.tg.title_keyword",
      severity: "WARNING",
      manual: !canChange,
      suggestion: { field: "title", value: fit(title ? `${title} | ${keywords[0]}` : keywords[0]!, TELEGRAM_TITLE_MAX) },
      detail: { fa: `عنوان («${title}») هیچ‌یک از کلیدواژه‌ها را ندارد.`, en: `The title (“${title}”) has none of the keywords.` },
      evidence: { title, keywords },
    });
  }
  if (charLength(title) > 40) {
    out.push({
      ruleId: "social.tg.title_length",
      severity: "INFO",
      manual: true,
      suggestion: null,
      detail: { fa: `عنوان ${charLength(title)} نویسه است.`, en: `The title is ${charLength(title)} characters long.` },
      evidence: { length: charLength(title) },
    });
  }

  const suggestedDescription = composeDescription(description, ctx, TELEGRAM_DESCRIPTION_MAX);
  if (!description.trim()) {
    out.push({
      ruleId: "social.tg.description_missing",
      severity: "SERIOUS",
      manual: !canChange,
      suggestion: { field: "description", value: suggestedDescription || null },
      detail: { fa: "کانال توضیحات ندارد.", en: "The channel has no description." },
      evidence: {},
    });
  } else {
    if (keywords.length && missingKeywords(description, keywords).length === keywords.length) {
      out.push({
        ruleId: "social.tg.description_keyword",
        severity: "WARNING",
        manual: !canChange,
        suggestion: { field: "description", value: suggestedDescription },
        detail: { fa: "توضیحات هیچ‌یک از کلیدواژه‌های هدف را ندارد.", en: "The description has none of the target keywords." },
        evidence: { keywords },
      });
    }
    if (!hasLink(description) || !hasCallToAction(description)) {
      out.push({
        ruleId: "social.tg.description_cta",
        severity: "INFO",
        manual: !canChange || (!a.settings.link && !a.settings.cta),
        suggestion: { field: "description", value: a.settings.link || a.settings.cta ? suggestedDescription : null },
        detail: {
          fa: hasLink(description) ? "توضیحات دعوت به اقدام ندارد." : "توضیحات لینک یا آیدی تماس ندارد.",
          en: hasLink(description) ? "The description has no call to action." : "The description has no link or contact @username.",
        },
        evidence: { hasLink: hasLink(description), hasCta: hasCallToAction(description) },
      });
    }
  }
  if (!a.username) {
    out.push({
      ruleId: "social.tg.public_username",
      severity: "SERIOUS",
      manual: true,
      suggestion: { field: "username", value: null },
      detail: { fa: "کانال خصوصی است و نام کاربری عمومی ندارد.", en: "The channel is private, with no public username." },
      evidence: {},
    });
  }
  if (!a.profile.pinnedMessageId) {
    out.push({
      ruleId: "social.tg.pinned",
      severity: "INFO",
      manual: false,
      suggestion: null,
      detail: { fa: "هیچ پیامی سنجاق نشده است.", en: "No message is pinned." },
      evidence: {},
    });
  }

  const posts = ctx.posts.slice(0, 30);
  const texts = posts.map((p) => p.features.length ?? charLength(p.caption)).filter((n) => n > 0);
  if (texts.length >= 6) {
    const med = median(texts)!;
    if (med > 1500 || med < 40) {
      out.push({
        ruleId: "social.tg.post_length",
        severity: "INFO",
        manual: false,
        suggestion: null,
        detail: { fa: `میانهٔ طول پست‌ها ${Math.round(med)} نویسه است.`, en: `The median post is ${Math.round(med)} characters.` },
        evidence: { medianLength: Math.round(med) },
      });
    }
    const long = posts.filter((p) => (p.features.length ?? 0) > 300);
    const plain = long.filter((p) => !p.features.formatted && (p.features.lineBreaks ?? 0) < 2);
    if (long.length >= 3 && plain.length / long.length > 0.5) {
      out.push({
        ruleId: "social.tg.formatting",
        severity: "INFO",
        manual: false,
        suggestion: null,
        detail: { fa: `${plain.length} از ${long.length} پست بلند بدون قالب‌بندی و پاراگراف است.`, en: `${plain.length} of ${long.length} long posts have no formatting or paragraphs.` },
        evidence: { plain: plain.length, long: long.length },
      });
    }
    const avgTags = mean(posts.map((p) => p.hashtags.length))!;
    if (avgTags > 5) {
      out.push({
        ruleId: "social.tg.hashtags",
        severity: "INFO",
        manual: false,
        suggestion: null,
        detail: { fa: `میانگین ${round2(avgTags)} هشتگ در هر پست.`, en: `An average of ${round2(avgTags)} hashtags per post.` },
        evidence: { averageHashtags: round2(avgTags) },
      });
    }
  }

  out.push(...cadence(ctx, "social.tg.cadence"));
  const members = a.followers;
  if (members && members > 0) {
    const rates = settledPosts(ctx.posts, ctx.now)
      .slice(0, 10)
      .map((p) => (typeof p.metrics.views === "number" ? (p.metrics.views / members) * 100 : null))
      .filter((v): v is number => v !== null);
    const trendFinding = trend(ctx, "social.tg.view_rate", (p) => (typeof p.metrics.views === "number" ? (p.metrics.views / members) * 100 : null), {
      fa: "نرخ بازدید",
      en: "View rate",
    });
    if (trendFinding.length) out.push(...trendFinding);
    else if (rates.length >= 5 && mean(rates)! < 10) {
      const avg = round2(mean(rates)!);
      out.push({
        ruleId: "social.tg.view_rate",
        severity: "INFO",
        manual: false,
        suggestion: null,
        detail: { fa: `نرخ بازدید ۱۰ پست اخیر به‌طور میانگین ${avg}٪ است.`, en: `The last 10 posts average a ${avg}% view rate.` },
        evidence: { averageViewRate: avg },
      });
    }
  }
  out.push(...bestHoursFinding(ctx, "social.tg.best_hours"));
  return out;
}

export function evaluate(ctx: Ctx): SocialFinding[] {
  return ctx.account.platform === "INSTAGRAM" ? instagramFindings(ctx) : telegramFindings(ctx);
}

// ---------------------------------------------------------------- running and storing

export function profileUrl(account: Pick<SocialAccount, "platform" | "username" | "externalId">): string {
  if (account.platform === "INSTAGRAM") return `https://www.instagram.com/${account.username ?? ""}/`;
  return account.username ? `https://t.me/${account.username}` : `tg:${account.externalId}`;
}

const PROPOSAL_ACTION: Partial<Record<Suggestion["field"], "SOCIAL_TITLE" | "SOCIAL_DESCRIPTION">> = {
  title: "SOCIAL_TITLE",
  description: "SOCIAL_DESCRIPTION",
};
const OPEN_PROPOSAL = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "APPLYING"] as const;

export type AuditOutcome = { runId: string; score: number; findings: SocialFinding[]; proposals: string[] };

/**
 * Evaluate, store as a run with issues and occurrences, and queue the
 * Telegram title/description proposals for approval (one per field, only when
 * none is already open).
 */
export async function runAudit(input: {
  project: Project;
  actor: Actor;
  trigger?: "MANUAL" | "SCHEDULE" | "API";
  now?: Date;
}): Promise<AuditOutcome> {
  const now = input.now ?? new Date();
  const account = await getAccount(input.project.id);
  if (!account || account.status === "NOT_CONNECTED") throw Object.assign(new Error("not_connected"), { code: "not_connected" });
  const posts = await db
    .select()
    .from(socialPosts)
    .where(and(eq(socialPosts.projectId, input.project.id), gte(socialPosts.publishedAt, new Date(now.getTime() - 120 * DAY))))
    .orderBy(desc(socialPosts.publishedAt))
    .limit(200);
  const ctx: Ctx = { account, posts, now, locale: input.project.locale === "en" ? "en" : "fa" };
  const findings = evaluate(ctx);
  const score = socialScore(findings);
  const url = profileUrl(account);

  const run = (
    await db
      .insert(auditRuns)
      .values({
        projectId: input.project.id,
        status: "SUCCEEDED",
        trigger: input.trigger ?? "MANUAL",
        idempotencyKey: `social-audit-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
        pagesCrawled: posts.length,
        pagesTotal: posts.length,
        score,
        scoreBreakdown: { kind: "social", platform: account.platform, findings: findings.length },
        startedAt: now,
        heartbeatAt: now,
        finishedAt: new Date(),
        createdById: input.actor.id ?? null,
      })
      .returning()
  )[0]!;

  const coreFindings: Finding[] = findings.map((f) => {
    const rule = socialRule(f.ruleId)!;
    return {
      ruleId: f.ruleId,
      category: rule.category,
      severity: f.severity,
      title: rule.title.en,
      url,
      evidence: { ...f.evidence, detail: f.detail, manual: f.manual, suggestion: f.suggestion, platform: account.platform },
    };
  });
  const groups = groupFindings(coreFindings);
  await issueService.persistFindings({ projectId: input.project.id, runId: run.id, groups, snapshotIdByUrl: new Map() });
  await db.update(projects).set({ score }).where(eq(projects.id, input.project.id));

  const proposals = account.platform === "TELEGRAM" && account.externalId ? await proposeTelegramChanges(input, account, findings, groups) : [];
  return { runId: run.id, score, findings, proposals };
}

async function proposeTelegramChanges(
  input: { project: Project; actor: Actor },
  account: SocialAccount,
  findings: SocialFinding[],
  groups: ReturnType<typeof groupFindings>,
): Promise<string[]> {
  const issues = await db
    .select({ id: seoIssues.id, fingerprint: seoIssues.fingerprint, ruleId: seoIssues.ruleId })
    .from(seoIssues)
    .where(eq(seoIssues.projectId, input.project.id));
  const issueId = (ruleId: string) => {
    const fp = groups.find((g) => g.ruleId === ruleId)?.fingerprint;
    return issues.find((i) => i.fingerprint === fp)?.id ?? null;
  };
  const open = await db
    .select({ action: fixProposals.action })
    .from(fixProposals)
    .where(and(eq(fixProposals.projectId, input.project.id), inArray(fixProposals.status, [...OPEN_PROPOSAL])));
  const drafts: proposalService.ProposalDraft[] = [];
  const seen = new Set<string>(open.map((o) => o.action));
  // The most severe finding for a field speaks for it: one proposal per field.
  const order: Severity[] = ["CRITICAL", "SERIOUS", "WARNING", "INFO"];
  for (const f of [...findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))) {
    const action = f.suggestion ? PROPOSAL_ACTION[f.suggestion.field] : undefined;
    if (!action || f.manual || !f.suggestion?.value || seen.has(action)) continue;
    const field = f.suggestion.field as "title" | "description";
    const before = field === "title" ? account.displayName : account.bio;
    if ((before ?? "") === f.suggestion.value) continue;
    seen.add(action);
    const rule = socialRule(f.ruleId)!;
    drafts.push({
      projectId: input.project.id,
      issueId: issueId(f.ruleId),
      ruleId: f.ruleId,
      action,
      risk: "SENSITIVE",
      title: field === "title" ? "Update the channel title" : "Update the channel description",
      rationale: `${rule.why.en}\n\n${rule.why.fa}`,
      changes: [{ url: telegramTarget(account.externalId!), field, before: before && before.length ? before : null, after: f.suggestion.value }],
    });
  }
  if (!drafts.length) return [];
  const created = await proposalService.createProposals({ orgId: input.project.orgId, actor: input.actor, drafts });
  return created.map((c) => c.id);
}

/** The latest social run and the project's issues, with each rule's text in both languages. */
export async function auditResults(projectId: string) {
  const run = (
    await db.select().from(auditRuns).where(eq(auditRuns.projectId, projectId)).orderBy(desc(auditRuns.queuedAt)).limit(1)
  )[0];
  const issues = await db.select().from(seoIssues).where(eq(seoIssues.projectId, projectId)).orderBy(desc(seoIssues.lastSeenAt));
  const proposals = await db.select().from(fixProposals).where(eq(fixProposals.projectId, projectId)).orderBy(desc(fixProposals.createdAt));
  const followers = await db
    .select({ date: socialMetricsDaily.date })
    .from(socialMetricsDaily)
    .where(eq(socialMetricsDaily.projectId, projectId))
    .limit(1);
  return {
    run: run ? { id: run.id, score: run.score, finishedAt: run.finishedAt?.toISOString() ?? null, trigger: run.trigger } : null,
    score: run?.score ?? null,
    hasData: followers.length > 0,
    findings: issues
      .filter((i) => i.ruleId.startsWith("social."))
      .map((i) => {
        const rule = socialRule(i.ruleId);
        const ev = ((i.data as { evidence?: Array<Record<string, unknown>> } | null)?.evidence?.[0] ?? {}) as Record<string, unknown>;
        const proposal = proposals.find((p) => p.issueId === i.id);
        return {
          issueId: i.id,
          ruleId: i.ruleId,
          category: i.category,
          severity: i.severity,
          status: i.status,
          title: rule?.title ?? { fa: i.title, en: i.title },
          why: rule?.why ?? null,
          detail: (ev.detail as LocalizedText | undefined) ?? null,
          manual: Boolean(ev.manual),
          suggestion: (ev.suggestion as Suggestion | null | undefined) ?? null,
          evidence: ev,
          firstSeenAt: i.firstSeenAt.toISOString(),
          lastSeenAt: i.lastSeenAt.toISOString(),
          proposal: proposal ? { id: proposal.id, action: proposal.action, status: proposal.status, risk: proposal.risk } : null,
        };
      }),
  };
}
