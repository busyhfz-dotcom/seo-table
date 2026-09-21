/**
 * robots.txt parsing — enough of RFC 9309 to be a good citizen:
 * longest-match Allow/Disallow with the standard wildcard rules, per-agent group
 * selection with a fallback to `*`, Crawl-delay, and Sitemap discovery.
 */
export type RobotsRule = { allow: boolean; pattern: string };

export type Robots = {
  groups: Map<string, RobotsRule[]>;
  crawlDelay: Map<string, number>;
  sitemaps: string[];
  raw: string;
  /** True when robots.txt was absent or errored; everything is then allowed. */
  missing: boolean;
};

export function parseRobots(text: string, missing = false): Robots {
  const groups = new Map<string, RobotsRule[]>();
  const crawlDelay = new Map<string, number>();
  const sitemaps: string[] = [];
  let currentAgents: string[] = [];
  let lastLineWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!lastLineWasAgent) currentAgents = [];
      currentAgents.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), []);
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
      for (const agent of currentAgents) {
        const rules = groups.get(agent) ?? [];
        // An empty Disallow means "allow everything" and carries no pattern.
        if (field === "disallow" && value === "") {
          rules.push({ allow: true, pattern: "/" });
        } else if (value !== "") {
          rules.push({ allow: field === "allow", pattern: value });
        }
        groups.set(agent, rules);
      }
    } else if (field === "crawl-delay") {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) {
        for (const agent of currentAgents) crawlDelay.set(agent, delay);
      }
    }
  }

  return { groups, crawlDelay, sitemaps, raw: text, missing };
}

function agentKey(robots: Robots, userAgent: string): string | null {
  const ua = userAgent.toLowerCase();
  let best: string | null = null;
  for (const key of robots.groups.keys()) {
    if (key === "*") continue;
    if (ua.includes(key) && (best === null || key.length > best.length)) best = key;
  }
  if (best) return best;
  return robots.groups.has("*") ? "*" : null;
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
  if (robots.missing) return true;
  const key = agentKey(robots, userAgent);
  if (!key) return true;
  const rules = robots.groups.get(key) ?? [];
  if (rules.length === 0) return true;

  let path: string;
  try {
    const u = new URL(url);
    path = `${u.pathname}${u.search}`;
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

export function crawlDelayFor(robots: Robots, userAgent: string): number | null {
  const key = agentKey(robots, userAgent);
  if (!key) return null;
  return robots.crawlDelay.get(key) ?? robots.crawlDelay.get("*") ?? null;
}

/** Extract <loc> values from a sitemap or sitemap index. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const locs: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1]) locs.push(decodeXmlEntities(m[1]));
  }
  return isIndex ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
