/**
 * The pure parts of the social features: the t.me preview parser on markup
 * shaped like Telegram's, count parsing, hashtags, Persian/Arabic keyword
 * matching, the Telegram HTML check, the OAuth state, post validation, and the
 * audit rules on in-memory data.
 */
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, type SocialAccount, type SocialPost } from "@seo/db";
import { closeRedis } from "@seo/core";
import { extractHashtags, parseChannelPreview, parseCount } from "@seo/connectors";
import { createState, planner, socialAudit, socialText, verifyState } from "@seo/social";

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

const FIXTURE = `<!DOCTYPE html><html><body class="widget_frame_base tgme_webpage">
<section class="tgme_channel_history js-message_history">
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="durov/310" data-view="eyJ">
  <div class="tgme_widget_message_bubble">
    <div class="tgme_widget_message_grouped_wrap js-message_grouped_wrap"><div class="tgme_widget_message_grouped js-message_grouped">
      <a class="tgme_widget_message_photo_wrap grouped_media_wrap" href="https://t.me/durov/310?single" style="left:0px;top:0px;width:394px;height:394px;background-image:url('https://cdn4.telesco.pe/file/a.jpg')"></a>
      <a class="tgme_widget_message_photo_wrap grouped_media_wrap" href="https://t.me/durov/311?single" style="background-image:url('https://cdn4.telesco.pe/file/b.jpg')"></a>
    </div></div>
    <div class="tgme_widget_message_text js-message_text" dir="auto"><b>Big news</b><br/>Line two with <a href="https://telegram.org/blog" target="_blank">a link</a> and <a href="?q=%23Telegram">#Telegram</a></div>
    <div class="tgme_widget_message_footer compact js-message_footer"><div class="tgme_widget_message_info short js-message_info">
      <span class="tgme_widget_message_views">4.23M</span><span class="copyonly"> views</span><span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/durov/310"><time datetime="2025-06-01T12:04:05+00:00" class="time">12:04</time></a></span>
    </div></div>
  </div></div></div>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message js-widget_message" data-post="durov/312">
  <div class="tgme_widget_message_bubble">
    <div class="tgme_widget_message_text js-message_text" dir="auto">سلام دنیا #تلگرام_فارسی</div>
    <div class="tgme_widget_message_footer"><div class="tgme_widget_message_info"><span class="tgme_widget_message_views">987</span>
    <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/durov/312"><time datetime="2025-06-02T08:00:00+00:00" class="time">08:00</time></a></span></div></div>
  </div></div></div>
</section>
<div class="tgme_channel_info">
  <div class="tgme_channel_info_header"><i class="tgme_page_photo_image bgcolor0"><img src="https://cdn4.telesco.pe/file/ava.jpg"></i>
    <div class="tgme_channel_info_header_title"><span dir="auto">Du Rove's Channel</span></div></div>
  <div class="tgme_channel_info_description">Thoughts from the founder<br/>of Telegram</div>
  <div class="tgme_channel_info_counters">
    <div class="tgme_channel_info_counter"><span class="counter_value">13.7M</span> <span class="counter_type">subscribers</span></div>
    <div class="tgme_channel_info_counter"><span class="counter_value">95</span> <span class="counter_type">photos</span></div>
  </div>
</div></body></html>`;

describe("Telegram public preview", () => {
  it("parses the channel header and posts with views, media, hashtags and formatting", () => {
    const out = parseChannelPreview(FIXTURE, "durov");
    expect(out).toMatchObject({
      username: "durov",
      title: "Du Rove's Channel",
      description: "Thoughts from the founder\nof Telegram",
      subscribers: 13_700_000,
      pictureUrl: "https://cdn4.telesco.pe/file/ava.jpg",
    });
    expect(out.posts.map((p) => p.id)).toEqual([312, 310]);
    expect(out.posts[1]).toMatchObject({
      type: "album",
      views: 4_230_000,
      publishedAt: "2025-06-01T12:04:05+00:00",
      permalink: "https://t.me/durov/310",
      mediaUrls: ["https://cdn4.telesco.pe/file/a.jpg", "https://cdn4.telesco.pe/file/b.jpg"],
      hashtags: ["telegram"],
      features: { formatted: true, links: 1, lineBreaks: 1 },
    });
    expect(out.posts[1]!.text).toBe("Big news\nLine two with a link and #Telegram");
    expect(out.posts[0]).toMatchObject({ type: "text", views: 987, hashtags: ["تلگرام_فارسی"] });
  });

  it.each([
    ["987", 987],
    ["1.2K", 1200],
    ["12.5K", 12500],
    ["3.4M", 3_400_000],
    ["1,234", 1234],
    ["", null],
    ["n/a", null],
  ] as const)("parseCount(%s) = %s", (raw, n) => expect(parseCount(raw)).toBe(n));

  it("extracts hashtags in any script, once each, lower-cased", () => {
    expect(extractHashtags("Hi #Coffee and #coffee, #قهوه_تازه! mail@x#no")).toEqual(["coffee", "قهوه_تازه"]);
  });
});

describe("text helpers", () => {
  it("matches keywords across Arabic and Persian spellings, digits and ZWNJ", () => {
    expect(socialText.containsKeyword("كافي‌شاپ يزد ۱۲", "کافی شاپ یزد 12")).toBe(true);
    expect(socialText.containsKeyword("Specialty COFFEE", "specialty coffee")).toBe(true);
    expect(socialText.containsKeyword(null, "x")).toBe(false);
  });

  it("finds calls to action and links in both languages", () => {
    expect(socialText.hasCallToAction("برای سفارش دایرکت بدید")).toBe(true);
    expect(socialText.hasCallToAction("Order via DM")).toBe(true);
    expect(socialText.hasCallToAction("Just coffee")).toBe(false);
    expect(socialText.hasLink("پشتیبانی: @roya_support")).toBe(true);
    expect(socialText.hasLink("roya.ir")).toBe(true);
    expect(socialText.hasLink("no link here")).toBe(false);
  });

  it("accepts Telegram HTML and names what Telegram would refuse", () => {
    expect(socialText.telegramHtmlProblems('<b>Hi</b> <a href="https://x.example">x</a> <span class="tg-spoiler">s</span> &amp;')).toEqual([]);
    expect(socialText.telegramHtmlProblems("<div>x</div>")).toContain("tag_not_allowed:div");
    expect(socialText.telegramHtmlProblems("<b>x")).toContain("unclosed:b");
    expect(socialText.telegramHtmlProblems("<a>x</a>")).toContain("link_needs_href");
    expect(socialText.telegramHtmlProblems("a & b")).toContain("bare_ampersand");
    expect(socialText.telegramHtmlProblems("1 < 2")).toContain("bare_lt");
  });
});

describe("OAuth state", () => {
  it("round-trips, and refuses tampering and expiry", () => {
    const s = createState({ userId: "u1", orgId: "o1", projectId: "p1" }, 1_000_000);
    expect(verifyState(s, 1_000_001)).toMatchObject({ u: "u1", o: "o1", p: "p1" });
    expect(verifyState(s, 1_000_000 + 11 * 60_000)).toBeNull();
    const [payload, sig] = s.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "attacker", o: "o1", p: "p1", n: "x", e: 9e15 })).toString("base64url");
    expect(verifyState(`${forged}.${sig}`, 1_000_001)).toBeNull();
    expect(verifyState(`${payload}.`, 1_000_001)).toBeNull();
    expect(verifyState(null)).toBeNull();
  });
});

describe("post validation", () => {
  const post = (format: string, media: Array<{ url: string; type: "image" | "video" }>, text = "hi") =>
    ({ op: "post", format, text, media }) as never;
  it.each([
    ["INSTAGRAM", post("image", [{ url: "https://c/a.jpg", type: "image" }]), []],
    ["INSTAGRAM", post("reel", [{ url: "https://c/a.jpg", type: "image" }]), ["reel_needs_one_video"]],
    ["INSTAGRAM", post("carousel", [{ url: "https://c/a.jpg", type: "image" }]), ["carousel_needs_2_to_10_items"]],
    ["INSTAGRAM", post("text", []), ["format_not_for_instagram"]],
    ["INSTAGRAM", { op: "pin", messageId: 1 } as never, ["instagram_supports_new_posts_only"]],
    ["TELEGRAM", post("text", [], "<b>ok</b>"), []],
    ["TELEGRAM", post("text", [], ""), ["text_required"]],
    ["TELEGRAM", post("album", [{ url: "https://c/a.jpg", type: "image" }]), ["album_needs_2_to_10_items"]],
    ["TELEGRAM", post("photo", [{ url: "https://c/a.jpg", type: "image" }], "x".repeat(1100)), ["caption_too_long:1024"]],
  ] as const)("%s %j → %j", (platform, payload, problems) => {
    expect(planner.validatePayload(platform, payload)).toEqual(problems);
  });
});

describe("audit rules", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  const account = (over: Partial<SocialAccount>): SocialAccount =>
    ({
      id: "a",
      projectId: "p",
      platform: "TELEGRAM",
      externalId: "-100",
      username: "chan",
      displayName: "Roya",
      bio: "",
      website: null,
      profile: { rights: { can_change_info: true } },
      settings: { keywords: ["قهوه"] },
      followers: 1000,
      following: null,
      mediaCount: null,
      scopes: [],
      status: "CONNECTED",
      ...over,
    }) as SocialAccount;
  const posts = (n: number, days: number): SocialPost[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      externalId: String(i),
      publishedAt: new Date(now.getTime() - (i * days + 3) * 86_400_000),
      caption: "text",
      hashtags: [],
      metrics: { views: 500 },
      features: { length: 100 },
      type: "text",
    })) as unknown as SocialPost[];

  it("flags a Telegram channel's missing keyword, description, pinned message and silence, with scores", () => {
    const findings = socialAudit.evaluate({ account: account({}), posts: posts(10, 4).map((p) => ({ ...p, publishedAt: new Date(p.publishedAt!.getTime() - 20 * 86_400_000) })), now, locale: "fa" });
    const ids = findings.map((f) => f.ruleId);
    expect(ids).toEqual(expect.arrayContaining(["social.tg.title_keyword", "social.tg.description_missing", "social.tg.pinned", "social.tg.cadence"]));
    expect(findings.find((f) => f.ruleId === "social.tg.cadence")!.severity).toBe("SERIOUS");
    expect(findings.find((f) => f.ruleId === "social.tg.title_keyword")!.suggestion).toEqual({ field: "title", value: "Roya | قهوه" });
    expect(socialAudit.socialScore(findings)).toBe(100 - findings.reduce((s, f) => s + ({ CRITICAL: 20, SERIOUS: 12, WARNING: 6, INFO: 2 })[f.severity], 0));
  });

  it("makes title changes manual when the bot lacks can_change_info, and never proposes a @username", () => {
    const findings = socialAudit.evaluate({ account: account({ profile: { rights: { can_change_info: false } }, username: null }), posts: [], now, locale: "en" });
    expect(findings.find((f) => f.ruleId === "social.tg.title_keyword")!.manual).toBe(true);
    expect(findings.find((f) => f.ruleId === "social.tg.public_username")).toMatchObject({ manual: true, severity: "SERIOUS" });
  });

  it("every rule has Persian and English text, and nothing English in the Persian", () => {
    for (const r of socialAudit.SOCIAL_RULES) {
      expect(r.title.fa).toMatch(/[؀-ۿ]/);
      expect(r.why.fa).toMatch(/[؀-ۿ]/);
      expect(r.title.en).not.toMatch(/[؀-ۿ]/);
      expect(r.why.en).not.toMatch(/[؀-ۿ]/);
    }
  });
});
