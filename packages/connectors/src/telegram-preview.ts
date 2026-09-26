/**
 * Telegram's public web preview of a channel, https://t.me/s/<username>.
 *
 * It is the only place Telegram publishes per-post view counts (the Bot API
 * never reports them), and it exists for public channels only: a private
 * channel, or one that disabled the preview, answers with a redirect to
 * t.me/<username>, reported as `no_public_preview`.
 *
 * Counts on the page are rounded by Telegram ("1.2K", "3.4M"), so a view count
 * parsed from here is accurate to about two significant figures; callers label
 * the source as public_preview. Fetches go through the SSRF guard, are bounded
 * in size and pages, and send nothing identifying the channel's owner.
 */
import * as cheerio from "cheerio";
import { guardedFetch } from "@seo/core";
import { ConnectorError } from "./types.js";
import { socialEndpoints } from "./social-endpoints.js";

export type PreviewPost = {
  id: number;
  permalink: string;
  publishedAt: string | null;
  text: string;
  views: number | null;
  type: "text" | "photo" | "album" | "video" | "other";
  mediaUrls: string[];
  hashtags: string[];
  features: { length: number; formatted: boolean; links: number; lineBreaks: number };
};

export type ChannelPreview = {
  username: string;
  title: string | null;
  description: string | null;
  pictureUrl: string | null;
  subscribers: number | null;
  posts: PreviewPost[];
};

export const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

/** "1.2K" → 1200, "3.4M" → 3400000, "987" → 987; null when unparseable. */
export function parseCount(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const m = /^([\d.,]+)\s*([KMB])?$/i.exec(raw.trim().replace(/\s+/g, ""));
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? "").toUpperCase() as "K" | "M" | "B"] ?? 1;
  return Math.round(n * mult);
}

/** Hashtags in a text (Latin, Persian/Arabic letters, digits, underscore), lower-cased, without "#". */
export function extractHashtags(text: string): string[] {
  const tags = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\p{L}\p{N}_])#([\p{L}\p{N}_]{2,64})/gu)) tags.add(m[1]!.toLowerCase());
  return [...tags];
}

const BG_URL = /background-image:\s*url\(['"]?([^'")]+)['"]?\)/i;

export function parseChannelPreview(html: string, username: string): ChannelPreview {
  const $ = cheerio.load(html);
  const text = (sel: string) => {
    const t = $(sel).first().text().trim();
    return t.length ? t : null;
  };
  let subscribers: number | null = null;
  $(".tgme_channel_info_counter").each((_, el) => {
    const type = $(el).find(".counter_type").text().trim().toLowerCase();
    if (/subscriber|member/.test(type)) subscribers = parseCount($(el).find(".counter_value").text());
  });
  // The description keeps its line breaks.
  const descEl = $(".tgme_channel_info_description").first();
  descEl.find("br").replaceWith("\n");
  const description = descEl.text().trim() || null;

  const posts: PreviewPost[] = [];
  $(".tgme_widget_message").each((_, el) => {
    const node = $(el);
    const dataPost = node.attr("data-post") ?? "";
    const id = Number(dataPost.split("/")[1]);
    if (!Number.isInteger(id) || id <= 0) return;
    const textEl = node.find(".tgme_widget_message_text").first();
    const htmlText = textEl.html() ?? "";
    const formatted = /<(b|strong|i|em|u|s|code|pre|blockquote)\b/i.test(htmlText);
    const links = textEl.find("a[href]").filter((_, a) => !/^\?q=%23/.test($(a).attr("href") ?? "")).length;
    const lineBreaks = textEl.find("br").length;
    textEl.find("br").replaceWith("\n");
    const body = textEl.text().trim();
    const photos = node.find(".tgme_widget_message_photo_wrap");
    const hasVideo = node.find(".tgme_widget_message_video_player, video").length > 0;
    const mediaUrls = photos
      .map((_, p) => BG_URL.exec($(p).attr("style") ?? "")?.[1] ?? null)
      .get()
      .filter((u): u is string => Boolean(u))
      .slice(0, 10);
    const type: PreviewPost["type"] = node.find(".tgme_widget_message_grouped_wrap").length
      ? "album"
      : hasVideo
        ? "video"
        : photos.length
          ? "photo"
          : body
            ? "text"
            : "other";
    posts.push({
      id,
      permalink: node.find("a.tgme_widget_message_date").attr("href") ?? `https://t.me/${username}/${id}`,
      publishedAt: node.find("time[datetime]").first().attr("datetime") ?? null,
      text: body,
      views: parseCount(node.find(".tgme_widget_message_views").first().text()),
      type,
      mediaUrls,
      hashtags: extractHashtags(body),
      features: { length: [...body].length, formatted, links, lineBreaks },
    });
  });

  return {
    username,
    title: text(".tgme_channel_info_header_title"),
    description,
    pictureUrl: $(".tgme_page_photo_image img").first().attr("src") ?? null,
    subscribers,
    // Newest first, like every other post list in the panel.
    posts: posts.sort((a, b) => b.id - a.id),
  };
}

const PAGE_BYTES = 1.5 * 1024 * 1024;

/**
 * The channel's header and its latest posts, reading at most `pages` pages
 * (about 20 posts each) back from the newest.
 */
export async function fetchChannelPreview(username: string, opts: { pages?: number } = {}): Promise<ChannelPreview> {
  const name = username.replace(/^@/, "");
  if (!USERNAME.test(name)) throw new ConnectorError("invalid_username", "Not a Telegram channel username");
  const base = socialEndpoints().telegramPreview.replace(/\/$/, "");
  let first: ChannelPreview | null = null;
  const seen = new Map<number, PreviewPost>();
  let before: number | undefined;
  for (let page = 0; page < Math.min(opts.pages ?? 3, 10); page++) {
    const url = `${base}/s/${encodeURIComponent(name)}${before ? `?before=${before}` : ""}`;
    let res;
    try {
      res = await guardedFetch(url, {
        headers: { "accept-language": "en", accept: "text/html" },
        timeoutMs: 15_000,
        maxBytes: PAGE_BYTES,
      });
    } catch {
      throw new ConnectorError("network_error", "The Telegram preview could not be reached");
    }
    if (res.status >= 300 && res.status < 400) {
      if (page === 0) throw new ConnectorError("no_public_preview", "This channel has no public preview (private, or the preview is disabled)");
      break;
    }
    if (res.status === 404 && page === 0) throw new ConnectorError("not_found", "No such Telegram channel");
    if (res.status >= 400) throw new ConnectorError("preview_error", `The Telegram preview answered HTTP ${res.status}`);
    const parsed = parseChannelPreview(res.body.toString("utf8"), name);
    if (page === 0) {
      if (!parsed.title && parsed.posts.length === 0) {
        throw new ConnectorError("no_public_preview", "This channel has no public preview (private, or the preview is disabled)");
      }
      first = parsed;
    }
    const before0 = seen.size;
    for (const p of parsed.posts) seen.set(p.id, p);
    const oldest = parsed.posts.at(-1)?.id;
    if (!oldest || seen.size === before0 || oldest <= 1) break;
    before = oldest;
  }
  return { ...first!, posts: [...seen.values()].sort((a, b) => b.id - a.id) };
}
