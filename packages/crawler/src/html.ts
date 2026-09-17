import type { PageSnapshot } from './types';

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, ' '));
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag))) {
    result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function firstContent(html: string, tag: string): string | undefined {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  const value = match ? stripTags(match[1]) : '';
  return value || undefined;
}

function metaContent(html: string, name: string): string | undefined {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const attrs = attributes(tag);
    if ((attrs.name ?? attrs.property ?? '').toLowerCase() === name.toLowerCase()) {
      return attrs.content || undefined;
    }
  }
  return undefined;
}

function linkHref(html: string, rel: string): string | undefined {
  const tags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const attrs = attributes(tag);
    const rels = (attrs.rel ?? '').toLowerCase().split(/\s+/);
    if (rels.includes(rel.toLowerCase()) && attrs.href) return attrs.href;
  }
  return undefined;
}

export function parseHtmlSnapshot(input: {
  html: string;
  url: string;
  statusCode: number;
  contentType?: string;
  fetchedAt?: string;
}): PageSnapshot {
  const h1s = [...input.html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)]
    .map((match) => stripTags(match[1]))
    .filter(Boolean);

  const images = input.html.match(/<img\b[^>]*>/gi) ?? [];
  let missingAltCount = 0;
  for (const image of images) {
    const attrs = attributes(image);
    if (!Object.prototype.hasOwnProperty.call(attrs, 'alt')) missingAltCount += 1;
  }

  const links: string[] = [];
  for (const tag of input.html.match(/<a\b[^>]*>/gi) ?? []) {
    const href = attributes(tag).href;
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
    try {
      links.push(new URL(href, input.url).toString());
    } catch {
      // Ignore invalid author-provided URLs.
    }
  }

  const origin = new URL(input.url).origin;
  const uniqueLinks = [...new Set(links)];

  let canonicalUrl: string | undefined;
  const canonicalHref = linkHref(input.html, 'canonical');
  if (canonicalHref) {
    try {
      canonicalUrl = new URL(canonicalHref, input.url).toString();
    } catch {
      canonicalUrl = undefined;
    }
  }

  return {
    url: input.url,
    statusCode: input.statusCode,
    contentType: input.contentType,
    title: firstContent(input.html, 'title'),
    metaDescription: metaContent(input.html, 'description'),
    canonicalUrl,
    robots: metaContent(input.html, 'robots'),
    h1s,
    imageCount: images.length,
    missingAltCount,
    links: uniqueLinks,
    internalLinks: uniqueLinks.filter((url) => {
      try {
        return new URL(url).origin === origin;
      } catch {
        return false;
      }
    }),
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
  };
}
