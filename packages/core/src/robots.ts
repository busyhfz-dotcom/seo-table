/**
 * robots.txt parsing — enough of RFC 9309 to be a good citizen:
 * longest-match Allow/Disallow with the standard wildcard rules, per-agent group
 * selection by product token with a fallback to `*`, Crawl-delay, and Sitemap
 * discovery.
 */
import { gunzipSync } from "node:zlib";

export type RobotsRule = { allow: boolean; pattern: string };

export type Robots = {
  groups: Map<string, RobotsRule[]>;
  crawlDelay: Map<string, number>;
  sitemaps: string[];
  raw: string;
  /** robots.txt answered 4xx (or redirected too often): everything is allowed. */
  missing: boolean;
  /**
   * robots.txt answered 5xx or could not be fetched. RFC 9309 §2.3.1.4 says to
   * assume a complete disallow then, so nothing is crawled.
   */
  unreachable: boolean;
};

/** How fetching robots.txt went: fetched, absent (4xx), or failing (5xx / network). */
export type RobotsState = "ok" | "missing" | "unreachable";

export function parseRobots(text: string, state: RobotsState = "ok"): Robots {
  const groups = new Map<string, RobotsRule[]>();
  const crawlDelay = new Map<string, number>();
  const sitemaps: string[] = [];
  let currentAgents: string[] = [];
  let lastLineWasAgent = false;

  for (const rawLine of text.split(/\r?\n|\r/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!lastLineWasAgent) currentAgents = [];
      const agent = productToken(value);
      currentAgents.push(agent);
      if (!groups.has(agent)) groups.set(agent, []);
      lastLineWasAgent = true;
      continue;
    }
    lastLineWasAgent = false;

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (currentAgents.length === 0) continue;

    if (field === "allow" || field === "disallow") {
      // An empty value matches nothing (RFC 9309 §2.2.2), so it adds no rule.
      if (value === "") continue;
      for (const agent of currentAgents) {
        groups.get(agent)!.push({ allow: field === "allow", pattern: normalizeRobotsPath(value) });
      }
    } else if (field === "crawl-delay") {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) {
        for (const agent of currentAgents) crawlDelay.set(agent, delay);
      }
    }
  }

  return {
    groups,
    crawlDelay,
    sitemaps,
    raw: text,
    missing: state === "missing",
    unreachable: state === "unreachable",
  };
}

/** `SeoTableBot/0.4 (+https://…)` → `seotablebot`: groups match on the product token only. */
export function productToken(userAgent: string): string {
  return (userAgent.trim().split(/[\s/]/)[0] ?? "").toLowerCase();
}

function agentKey(robots: Robots, userAgent: string): string | null {
  const token = productToken(userAgent);
  if (token && token !== "*" && robots.groups.has(token)) return token;
  return robots.groups.has("*") ? "*" : null;
}

/**
 * RFC 9309 §2.2.2: before comparing, non-ASCII is percent-encoded as UTF-8,
 * escapes are compared with uppercase hex, and an escaped unreserved character
 * is the character itself. Applied to both patterns and paths, so a Persian
 * Disallow written literally matches the percent-encoded path the URL carries.
 */
export function normalizeRobotsPath(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; ) {
    const ch = s[i]!;
    if (ch === "%" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      const code = parseInt(s.slice(i + 1, i + 3), 16);
      const decoded = String.fromCharCode(code);
      out += /[A-Za-z0-9\-._~]/.test(decoded) ? decoded : `%${s.slice(i + 1, i + 3).toUpperCase()}`;
      i += 3;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    if (cp > 0x7f) {
      try {
        out += encodeURIComponent(s.slice(i, i + width));
      } catch {
        out += s.slice(i, i + width); // a lone surrogate cannot be encoded; keep it
      }
    } else {
      out += ch;
    }
    i += width;
  }
  return out;
}

function patternToRegex(pattern: string): RegExp {
  let src = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") src += ".*";
    else if (ch === "$" && i === pattern.length - 1) src += "$";
    else src += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${src}`);
}

export function isAllowed(robots: Robots, url: string, userAgent: string): boolean {
  if (robots.unreachable) return false;
  if (robots.missing) return true;
  const key = agentKey(robots, userAgent);
  if (!key) return true;
  const rules = robots.groups.get(key) ?? [];
  if (rules.length === 0) return true;

  let path: string;
  try {
    const u = new URL(url);
    path = normalizeRobotsPath(`${u.pathname}${u.search}`);
  } catch {
    return false;
  }

  // Longest matching pattern wins; Allow wins a tie (RFC 9309 §2.2.2).
  let bestLength = -1;
  let allowed = true;
  for (const rule of rules) {
    if (!patternToRegex(rule.pattern).test(path)) continue;
    const len = rule.pattern.length;
    if (len > bestLength || (len === bestLength && rule.allow)) {
      bestLength = len;
      allowed = rule.allow;
    }
  }
  return bestLength === -1 ? true : allowed;
}

/** The delay of the group that applies; a specific group does not inherit `*`'s. */
export function crawlDelayFor(robots: Robots, userAgent: string): number | null {
  const key = agentKey(robots, userAgent);
  if (!key) return null;
  return robots.crawlDelay.get(key) ?? null;
}

/** Sitemap bodies may be gzip files served without Content-Encoding. */
export function decodeSitemapBody(body: Buffer, maxBytes: number): string {
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
    // maxOutputLength makes a decompression bomb throw instead of filling memory.
    return gunzipSync(body, { maxOutputLength: maxBytes }).toString("utf8");
  }
  return body.toString("utf8");
}

/** Extract <loc> values from a sitemap or sitemap index. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const isIndex = /<(?:[\w-]+:)?sitemapindex[\s>]/i.test(xml);
  const locs: string[] = [];
  const re = /<((?:[\w-]+:)?loc)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const raw = m[2] ?? "";
    const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
    const value = (cdata ? cdata[1]! : decodeXmlEntities(raw)).trim();
    if (value) locs.push(value);
  }
  return isIndex ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[ent] ?? whole;
  });
}
