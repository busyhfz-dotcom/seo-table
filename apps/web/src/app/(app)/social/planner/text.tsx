/**
 * Post text as each platform counts and shows it: Telegram's HTML subset (the
 * limits count visible characters, not markup), its checks before saving, a
 * preview built as React elements (never injected HTML), and Instagram's
 * hashtags.
 */
import type { ReactNode } from "react";

const TG_TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a", "code", "pre", "tg-spoiler", "span", "blockquote", "tg-emoji"]);

export const TG_TEXT_MAX = 4096;
export const TG_CAPTION_MAX = 1024;
export const IG_CAPTION_MAX = 2200;
export const IG_HASHTAGS_MAX = 30;

/** The same checks as the server (packages/social text.ts), so problems show while typing. */
export function telegramHtmlProblems(html: string): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  for (const m of html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [whole, rawName, attrs] = m;
    const name = rawName!.toLowerCase();
    if (!TG_TAGS.has(name)) {
      problems.push(`tag_not_allowed:${name}`);
      continue;
    }
    if (name === "span" && !whole.startsWith("</") && !/class=["']tg-spoiler["']/.test(attrs ?? "")) problems.push("span_needs_tg_spoiler");
    if (name === "a" && !whole.startsWith("</") && !/href=["'](https?:\/\/|tg:\/\/)[^"']+["']/.test(attrs ?? "")) problems.push("link_needs_href");
    if (whole.startsWith("</")) {
      if (stack.pop() !== name) problems.push(`unbalanced:${name}`);
    } else stack.push(name);
  }
  if (stack.length) problems.push(`unclosed:${stack.join(",")}`);
  if (/<(?![a-zA-Z/])/.test(html)) problems.push("bare_lt");
  if (/&(?!(lt|gt|amp|quot|#\d+|#x[0-9a-f]+);)/i.test(html)) problems.push("bare_ampersand");
  return [...new Set(problems)];
}

export function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

export function hashtags(text: string): string[] {
  return text.match(/#[\p{L}\p{N}_]+/gu) ?? [];
}

export function length(text: string): number {
  return [...text].length;
}

function decode(s: string): string {
  return visibleText(s);
}

type Node = { tag: string; href?: string; spoiler?: boolean; children: Array<Node | string> };

/** Telegram HTML → elements; anything outside the subset stays literal text, as Telegram would refuse it anyway. */
export function TelegramPreview({ html }: { html: string }) {
  const root: Node = { tag: "root", children: [] };
  const stack: Node[] = [root];
  let last = 0;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const top = stack[stack.length - 1]!;
    if (m.index! > last) top.children.push(decode(html.slice(last, m.index)));
    last = m.index! + m[0].length;
    const [, close, rawName, attrs] = m;
    const name = rawName!.toLowerCase();
    if (!TG_TAGS.has(name)) {
      top.children.push(m[0]);
      continue;
    }
    if (close) {
      if (stack.length > 1 && top.tag === name) stack.pop();
      continue;
    }
    const node: Node = {
      tag: name,
      children: [],
      ...(name === "a" ? { href: /href=["']([^"']+)["']/.exec(attrs ?? "")?.[1] ?? "" } : {}),
      ...(name === "tg-spoiler" || (name === "span" && /tg-spoiler/.test(attrs ?? "")) ? { spoiler: true } : {}),
    };
    top.children.push(node);
    stack.push(node);
  }
  if (last < html.length) stack[stack.length - 1]!.children.push(decode(html.slice(last)));
  return <>{render(root.children)}</>;
}

function lines(text: string, key: string): ReactNode[] {
  return text.split("\n").flatMap((part, i) => (i === 0 ? [part] : [<br key={`${key}-${i}`} />, part]));
}

function render(children: Array<Node | string>, prefix = "n"): ReactNode[] {
  return children.map((child, i) => {
    const key = `${prefix}-${i}`;
    if (typeof child === "string") return <span key={key}>{lines(child, key)}</span>;
    const inner = render(child.children, key);
    switch (child.tag) {
      case "b":
      case "strong":
        return <b key={key}>{inner}</b>;
      case "i":
      case "em":
        return <i key={key}>{inner}</i>;
      case "u":
      case "ins":
        return <u key={key}>{inner}</u>;
      case "s":
      case "strike":
      case "del":
        return <s key={key}>{inner}</s>;
      case "a":
        return (
          <span key={key} className="tg-link" title={child.href}>
            {inner}
          </span>
        );
      case "code":
        return <code key={key}>{inner}</code>;
      case "pre":
        return <pre key={key}>{inner}</pre>;
      case "blockquote":
        return <blockquote key={key}>{inner}</blockquote>;
      default:
        return child.spoiler ? (
          <span key={key} className="tg-spoiler">
            {inner}
          </span>
        ) : (
          <span key={key}>{inner}</span>
        );
    }
  });
}

/** An Instagram caption with its hashtags set apart. */
export function CaptionPreview({ text }: { text: string }) {
  const parts = text.split(/(#[\p{L}\p{N}_]+)/u);
  return <>{parts.map((p, i) => (i % 2 === 1 ? <span key={i} className="tg-link">{p}</span> : <span key={i}>{lines(p, `c${i}`)}</span>))}</>;
}
