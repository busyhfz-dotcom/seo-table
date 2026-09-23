/**
 * Schema markup for a page: what the page already declares (from the latest
 * scan), a template prefilled from what the crawl saw, validation, conflicts
 * with the existing markup, and applying through the fix pipeline.
 *
 * Applying writes the page's `jsonld` field on the write target — on the
 * Cloudflare edge, a set of JSON-LD blocks injected before </head>. The edge
 * adds; it never removes the page's own markup, so a type the page already
 * declares is reported as a conflict (two Product nodes confuse Google) and
 * the person decides. Blocks the edge already injects for that page are kept,
 * except one of the same type, which the new block replaces.
 */
import { BadRequest, type Actor } from "@seo/core";
import { h1Of, key, latestCrawl, projectById, proposeSiteChange, currentValue, titleWithoutBrand, type SitePage, type SiteProposal } from "../site.js";
import { buildJsonLd, TEMPLATE_INPUTS } from "./generate.js";
import { nodeTypes, schemaNodes, validateJsonLd, validateNode, SUPPORTED_TYPES, type SchemaIssue, type SchemaType } from "./validate.js";

type Node = Record<string, unknown>;

export type ExistingSchema =
  | { status: "no_scan" | "needs_rescan" | "not_crawled" }
  | { status: "ok"; url: string; scannedAt: string | null; blocks: unknown[]; nodes: Array<{ type: string; node: Node; issues: SchemaIssue[] }> };

async function crawledPage(projectId: string, url: string): Promise<{ page: SitePage | null; status: "ok" | "no_scan" | "needs_rescan" | "not_crawled"; scannedAt: string | null }> {
  const crawl = await latestCrawl(projectId);
  if (!crawl) return { page: null, status: "no_scan", scannedAt: null };
  const page = crawl.byUrl.get(key(url)) ?? null;
  const scannedAt = crawl.finishedAt?.toISOString() ?? null;
  if (!page) return { page: null, status: "not_crawled", scannedAt };
  if (!page.details) return { page, status: "needs_rescan", scannedAt };
  return { page, status: "ok", scannedAt };
}

export async function existingSchema(projectId: string, url: string): Promise<ExistingSchema> {
  const { page, status, scannedAt } = await crawledPage(projectId, url);
  if (status !== "ok" || !page?.details) return { status: status === "ok" ? "needs_rescan" : status };
  const blocks = page.details.jsonLd;
  const nodes = blocks.flatMap((b) => validateJsonLd(b).map((v, i) => ({ type: v.type, node: schemaNodes(b)[i]!, issues: v.issues })));
  return { status: "ok", url: page.url, scannedAt, blocks, nodes };
}

export type Conflict = { level: "warning" | "info"; code: string; type: string; property?: string; message: { fa: string; en: string } };

const t = (fa: string, en: string) => ({ fa, en });

function scalar(v: unknown): string | null {
  if (typeof v === "string" || typeof v === "number") return String(v).trim();
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const n = v as Node;
    for (const k of ["name", "url", "@id"]) if (typeof n[k] === "string") return (n[k] as string).trim();
  }
  return null;
}

/** How a new node collides with the page's own markup. */
export function conflictsWith(existing: Node[], proposed: Node): Conflict[] {
  const out: Conflict[] = [];
  const types = nodeTypes(proposed);
  for (const type of types) {
    const same = existing.filter((n) => nodeTypes(n).includes(type));
    if (!same.length) continue;
    out.push({
      level: "warning",
      code: "duplicate_type",
      type,
      message: t(
        `صفحه همین حالا نشانه‌گذاری ${type} دارد؛ افزودن دومی ممکن است گوگل را سردرگم کند. یکی را در منبع صفحه حذف کنید یا از افزودن صرف‌نظر کنید.`,
        `The page already declares ${type}; adding a second one can confuse Google. Remove one in the page source, or skip adding it.`,
      ),
    });
    for (const [prop, value] of Object.entries(proposed)) {
      if (prop.startsWith("@")) continue;
      const mine = scalar(value);
      if (mine === null) continue;
      for (const n of same) {
        const theirs = scalar(n[prop]);
        if (theirs !== null && theirs !== mine) {
          out.push({
            level: "warning",
            code: "value_differs",
            type,
            property: prop,
            message: t(`«${prop}» در نشانه‌گذاری فعلی صفحه «${theirs}» است و در نسخهٔ تازه «${mine}».`, `"${prop}" is "${theirs}" in the page's markup and "${mine}" in the new block.`),
          });
          break;
        }
      }
    }
  }
  return out;
}

function firstNode(existing: Node[], type: string): Node | null {
  return existing.find((n) => nodeTypes(n).some((x) => x === type || (type === "Article" && ["NewsArticle", "BlogPosting"].includes(x)))) ?? null;
}

/**
 * A template's fields filled from the page as crawled — its title, H1, meta
 * description, first image, Last-Modified — and from the page's own markup of
 * the same type (which is real data the site already publishes). Anything else
 * (prices, ratings, opening hours, addresses) is left for the person.
 */
export async function prefill(projectId: string, type: SchemaType, url: string | null): Promise<{ data: Record<string, unknown>; from: string[] }> {
  const project = await projectById(projectId);
  const from: string[] = [];
  const target = url ?? project.baseUrl;
  const { page } = await crawledPage(projectId, target);
  const existing = page?.details ? page.details.jsonLd.flatMap((b) => schemaNodes(b)) : [];
  const own = firstNode(existing, type === "LocalBusiness" ? "LocalBusiness" : type);
  const h1 = page ? h1Of(page) : null;
  const name = h1 ?? titleWithoutBrand(page?.title ?? null);
  const image = page?.details?.images.find((i) => /^https?:/.test(i.src))?.src ?? null;
  if (page) from.push("crawl");
  if (own) from.push("page_markup");
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const origin = new URL(project.baseUrl).origin;
  let data: Record<string, unknown>;
  switch (type) {
    case "Organization":
      data = { name: str(own?.name) ?? project.name, url: str(own?.url) ?? `${origin}/`, logo: scalar(own?.logo), description: str(own?.description), sameAs: Array.isArray(own?.sameAs) ? own!.sameAs : undefined };
      break;
    case "LocalBusiness":
      data = { name: str(own?.name) ?? project.name, url: str(own?.url) ?? `${origin}/`, telephone: str(own?.telephone), description: str(own?.description) ?? page?.metaDescription ?? null, image: image ? [image] : undefined, address: own?.address && typeof own.address === "object" ? own.address : undefined };
      break;
    case "WebSite":
      data = { name: str(own?.name) ?? project.name, url: `${origin}/` };
      break;
    case "BreadcrumbList": {
      const crawl = await latestCrawl(projectId);
      const items: Array<{ name: string; url: string }> = [];
      const u = new URL(target);
      const segments = u.pathname.split("/").filter(Boolean);
      const home = crawl?.byUrl.get(key(`${origin}/`));
      items.push({ name: home ? (titleWithoutBrand(home.title) ?? project.name) : project.name, url: `${origin}/` });
      // Only levels that exist as crawled pages: a breadcrumb to a 404 is worse than none.
      for (let i = 1; i <= segments.length; i++) {
        const path = `/${segments.slice(0, i).join("/")}`;
        const p = crawl?.byUrl.get(key(`${origin}${path}`)) ?? crawl?.byUrl.get(key(`${origin}${path}/`));
        if (p && p.statusCode === 200) items.push({ name: h1Of(p) ?? titleWithoutBrand(p.title) ?? segments[i - 1]!, url: p.url });
      }
      data = { items };
      break;
    }
    case "Article":
    case "BlogPosting":
    case "NewsArticle":
      data = {
        headline: str(own?.headline) ?? name,
        description: str(own?.description) ?? page?.metaDescription ?? null,
        image: image ? [image] : undefined,
        datePublished: str(own?.datePublished),
        dateModified: str(own?.dateModified) ?? page?.details?.lastModified?.toISOString() ?? null,
        url: page?.url ?? target,
        publisher: { name: project.name },
      };
      break;
    case "Product":
      data = { name: str(own?.name) ?? name, description: str(own?.description) ?? page?.metaDescription ?? null, image: image ? [image] : undefined, sku: str(own?.sku), url: page?.url ?? target };
      break;
    case "FAQPage": {
      // Questions the page asks in its headings; answers are the person's to paste.
      const questions = (page?.details?.headings ?? []).filter((h) => h.l >= 2 && /[?؟]\s*$/.test(h.t)).slice(0, 20);
      data = { items: questions.map((q) => ({ question: q.t, answer: "" })) };
      break;
    }
    case "HowTo":
      data = { name, description: page?.metaDescription ?? null, steps: [] };
      break;
    case "Person":
      data = { name: str(own?.name) ?? null, url: str(own?.url) ?? null };
      break;
    case "Event":
      data = { name, description: page?.metaDescription ?? null, image: image ? [image] : undefined };
      break;
  }
  return { data, from };
}

export type Preview = { jsonld: Node; issues: SchemaIssue[]; conflicts: Conflict[]; existing: ExistingSchema };

export async function preview(projectId: string, input: { type: SchemaType; data: unknown; url: string | null }): Promise<Preview> {
  const parsed = TEMPLATE_INPUTS[input.type === "BlogPosting" || input.type === "NewsArticle" ? "Article" : input.type].safeParse(input.data);
  if (!parsed.success) {
    throw new BadRequest("The form is not valid", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  const jsonld = buildJsonLd(input.type, parsed.data);
  const existing = input.url ? await existingSchema(projectId, input.url) : ({ status: "not_crawled" } as const);
  const existingNodes = existing.status === "ok" ? existing.nodes.map((n) => n.node) : [];
  return { jsonld, issues: validateNode(jsonld), conflicts: conflictsWith(existingNodes, jsonld), existing };
}

/** Validate markup the person pasted or edited by hand. */
export function validatePasted(value: unknown): Array<{ type: string; issues: SchemaIssue[] }> {
  return validateJsonLd(value);
}

/**
 * Propose the block for a page. Refused when it has errors (markup Google
 * would reject should not be published) and when the write target cannot
 * inject JSON-LD.
 */
export async function proposeSchema(input: {
  projectId: string;
  orgId: string;
  actor: Actor;
  url: string;
  jsonld: Node;
}): Promise<SiteProposal & { issues: SchemaIssue[]; conflicts: Conflict[] }> {
  const project = await projectById(input.projectId);
  if (new URL(input.url).hostname.replace(/^www\./, "") !== new URL(project.baseUrl).hostname.replace(/^www\./, "")) {
    throw new BadRequest("The page must be on this project's site", { field: "url" });
  }
  const nodes = schemaNodes(input.jsonld);
  if (nodes.length !== 1) throw new BadRequest("Send exactly one JSON-LD object with an @type");
  const issues = validateNode(input.jsonld);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) throw new BadRequest("The markup has errors; fix them before applying", { issues: errors });
  const type = nodeTypes(input.jsonld)[0]!;
  const before = await currentValue(input.projectId, input.url, "jsonld");
  let blocks: Node[] = [];
  if (before) {
    try {
      const parsed: unknown = JSON.parse(before);
      blocks = (Array.isArray(parsed) ? parsed : [parsed]).filter((b): b is Node => Boolean(b) && typeof b === "object");
    } catch {
      blocks = [];
    }
  }
  const after = [...blocks.filter((b) => !nodeTypes(b).includes(type)), input.jsonld];
  const existing = await existingSchema(input.projectId, input.url);
  const conflicts = conflictsWith(existing.status === "ok" ? existing.nodes.map((n) => n.node) : [], input.jsonld);
  const result = await proposeSiteChange({
    projectId: input.projectId,
    orgId: input.orgId,
    actor: input.actor,
    action: "SCHEMA_MARKUP",
    ruleId: "tool.schema_markup",
    title: `Add ${type} structured data`,
    rationale: `${type} JSON-LD for ${input.url}, validated against Google's documented properties.`,
    changes: [{ url: input.url, field: "jsonld", before, after: JSON.stringify(after) }],
  });
  return { ...result, issues, conflicts };
}

export { SUPPORTED_TYPES };
