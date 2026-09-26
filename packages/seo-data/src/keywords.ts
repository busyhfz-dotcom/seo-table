/**
 * Tracked keywords: the list a project watches, with each keyword's latest
 * numbers from every source that has them. Sources stay separate — a Search
 * Console average position and a DataForSEO rank are different measurements and
 * are never blended into one number.
 */
import { z } from "zod";
import { and, db, eq, inArray, isNull, keywords, sql, type Keyword } from "@seo/db";
import { BadRequest, NotFound } from "@seo/core";
import { isSupportedCountry } from "./countries.js";
import { normalizePhrase, phraseKey } from "./text.js";

export const MAX_BULK_KEYWORDS = 500;
/** Per project, so a runaway import cannot turn a daily sync into thousands of paid SERP checks. */
export const MAX_KEYWORDS_PER_PROJECT = 5000;

const tag = z.string().trim().min(1).max(40);

export const keywordInput = z.object({
  phrase: z.string().trim().min(1).max(200),
  locale: z.string().trim().regex(/^[a-z]{2}$/).default("fa"),
  country: z
    .string()
    .trim()
    .transform((c) => c.toUpperCase())
    .refine(isSupportedCountry, "unsupported country")
    .default("IR"),
  device: z.enum(["desktop", "mobile"]).nullable().default(null),
  targetUrl: z.string().trim().url().max(2000).nullable().default(null),
  tags: z.array(tag).max(20).default([]),
});

export const addKeywordsInput = z
  .object({
    keywords: z.array(keywordInput).max(MAX_BULK_KEYWORDS).optional(),
    /** Convenience for a paste box: one phrase per line, sharing the settings below. */
    phrases: z.string().max(100_000).optional(),
    locale: z.string().trim().regex(/^[a-z]{2}$/).optional(),
    country: z.string().trim().optional(),
    device: z.enum(["desktop", "mobile"]).nullable().optional(),
    tags: z.array(tag).max(20).optional(),
  })
  .refine((b) => (b.keywords?.length ?? 0) > 0 || Boolean(b.phrases?.trim()), "send keywords or phrases");

export type AddKeywordsInput = z.infer<typeof addKeywordsInput>;

function expand(input: AddKeywordsInput): Array<z.infer<typeof keywordInput>> {
  const out = [...(input.keywords ?? [])];
  if (input.phrases) {
    for (const line of input.phrases.split(/\r?\n|[,،]/)) {
      const phrase = line.trim();
      if (!phrase) continue;
      const parsed = keywordInput.safeParse({
        phrase,
        locale: input.locale,
        country: input.country,
        device: input.device ?? null,
        tags: input.tags,
      });
      if (!parsed.success) throw new BadRequest("A keyword is not valid", { phrase, issues: parsed.error.issues.map((i) => i.message) });
      out.push(parsed.data);
    }
  }
  if (out.length > MAX_BULK_KEYWORDS) throw new BadRequest(`At most ${MAX_BULK_KEYWORDS} keywords per request`);
  return out;
}

export async function addKeywords(
  projectId: string,
  input: AddKeywordsInput,
): Promise<{ added: Keyword[]; skipped: number }> {
  const items = expand(input);
  // Duplicates inside the batch collapse here; duplicates of stored keywords fall to the unique index.
  const seen = new Set<string>();
  const rows = [];
  for (const k of items) {
    const phrase = normalizePhrase(k.phrase);
    const key = `${phraseKey(phrase)}\u0000${k.country}\u0000${k.device ?? ""}`;
    if (!phrase || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      projectId,
      phrase,
      locale: k.locale,
      country: k.country,
      device: k.device,
      targetUrl: k.targetUrl,
      tags: [...new Set(k.tags)],
    });
  }
  const [{ n }] = (await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM keywords WHERE project_id = ${projectId} AND archived_at IS NULL
  `)).rows as [{ n: number }];
  if (n + rows.length > MAX_KEYWORDS_PER_PROJECT) {
    throw new BadRequest(`A project can track at most ${MAX_KEYWORDS_PER_PROJECT} keywords`, { tracked: n });
  }
  const added = rows.length ? await db.insert(keywords).values(rows).onConflictDoNothing().returning() : [];
  return { added, skipped: items.length - added.length };
}

export const updateKeywordInput = z.object({
  targetUrl: z.string().trim().url().max(2000).nullable().optional(),
  tags: z.array(tag).max(20).optional(),
  archived: z.boolean().optional(),
});

export async function updateKeyword(
  projectId: string,
  keywordId: string,
  input: z.infer<typeof updateKeywordInput>,
): Promise<Keyword> {
  const set: Partial<typeof keywords.$inferInsert> = {};
  if (input.targetUrl !== undefined) set.targetUrl = input.targetUrl;
  if (input.tags !== undefined) set.tags = [...new Set(input.tags)];
  if (input.archived !== undefined) set.archivedAt = input.archived ? new Date() : null;
  if (Object.keys(set).length === 0) throw new BadRequest("Nothing to update");
  const updated = await db
    .update(keywords)
    .set(set)
    .where(and(eq(keywords.id, keywordId), eq(keywords.projectId, projectId)))
    .returning();
  if (!updated[0]) throw new NotFound("Keyword not found");
  return updated[0];
}

export async function deleteKeyword(projectId: string, keywordId: string): Promise<void> {
  const gone = await db
    .delete(keywords)
    .where(and(eq(keywords.id, keywordId), eq(keywords.projectId, projectId)))
    .returning({ id: keywords.id });
  if (!gone[0]) throw new NotFound("Keyword not found");
}

export const bulkKeywordInput = z.object({
  action: z.enum(["archive", "unarchive", "delete", "add_tag", "remove_tag"]),
  ids: z.array(z.string().min(1).max(30)).min(1).max(MAX_BULK_KEYWORDS),
  tag: tag.optional(),
});

export async function bulkKeywords(projectId: string, input: z.infer<typeof bulkKeywordInput>): Promise<{ affected: number }> {
  const scope = and(eq(keywords.projectId, projectId), inArray(keywords.id, input.ids));
  let affected: Array<{ id: string }>;
  switch (input.action) {
    case "archive":
      affected = await db.update(keywords).set({ archivedAt: new Date() }).where(and(scope, isNull(keywords.archivedAt))).returning({ id: keywords.id });
      break;
    case "unarchive":
      affected = await db.update(keywords).set({ archivedAt: null }).where(scope).returning({ id: keywords.id });
      break;
    case "delete":
      affected = await db.delete(keywords).where(scope).returning({ id: keywords.id });
      break;
    case "add_tag":
    case "remove_tag": {
      if (!input.tag) throw new BadRequest("tag is required");
      const expr =
        input.action === "add_tag"
          ? sql`(SELECT array_agg(DISTINCT t) FROM unnest(array_append(${keywords.tags}, ${input.tag}::text)) AS t)`
          : sql`array_remove(${keywords.tags}, ${input.tag}::text)`;
      affected = await db.update(keywords).set({ tags: expr }).where(scope).returning({ id: keywords.id });
      break;
    }
  }
  return { affected: affected.length };
}

export async function activeKeywords(projectId: string): Promise<Keyword[]> {
  return db
    .select()
    .from(keywords)
    .where(and(eq(keywords.projectId, projectId), isNull(keywords.archivedAt)));
}

export type KeywordListItem = Keyword & {
  /** Search Console, impression-weighted over the last 7 days of data, and the 7 before. */
  gsc: {
    position: number | null;
    previousPosition: number | null;
    clicks: number;
    impressions: number;
    url: string | null;
    lastDate: string | null;
  } | null;
  /** The latest DataForSEO SERP check. position null = not in the top 100. */
  serp: { position: number | null; url: string | null; features: string[]; date: string } | null;
  /** From cached DataForSEO research for this phrase and market, when any exists. */
  metrics: { volume: number | null; difficulty: number | null; cpc: number | null; fetchedAt: string } | null;
};

type ListRow = Keyword & {
  gsc_position: number | null;
  gsc_prev_position: number | null;
  gsc_clicks: number | null;
  gsc_impressions: number | null;
  gsc_url: string | null;
  gsc_last_date: string | null;
  serp_position: number | null;
  serp_url: string | null;
  serp_features: string[] | null;
  serp_date: string | null;
  m_volume: number | null;
  m_difficulty: number | null;
  m_cpc: number | null;
  m_fetched_at: Date | null;
};

export async function listKeywords(
  projectId: string,
  filter: { tag?: string; q?: string; archived?: boolean } = {},
): Promise<{ keywords: KeywordListItem[]; tags: string[] }> {
  const res = await db.execute(sql`
    WITH last AS (
      SELECT p.keyword_id, max(p.date) AS last_date
      FROM keyword_positions p JOIN keywords k ON k.id = p.keyword_id
      WHERE k.project_id = ${projectId} AND p.source = 'gsc'
      GROUP BY p.keyword_id
    )
    SELECT k.id, k.project_id AS "projectId", k.phrase, k.locale, k.country, k.device, k.target_url AS "targetUrl",
           k.tags, k.created_at AS "createdAt", k.archived_at AS "archivedAt",
           g.position AS gsc_position, g.prev_position AS gsc_prev_position, g.clicks AS gsc_clicks,
           g.impressions AS gsc_impressions, g.url AS gsc_url, last.last_date::text AS gsc_last_date,
           s.position AS serp_position, s.url AS serp_url, s.serp_features, s.date::text AS serp_date,
           m.volume AS m_volume, m.difficulty AS m_difficulty, m.cpc AS m_cpc, m.created_at AS m_fetched_at
    FROM keywords k
    LEFT JOIN last ON last.keyword_id = k.id
    LEFT JOIN LATERAL (
      SELECT
        sum(p.position * p.impressions) FILTER (WHERE p.date > last.last_date - 7) / nullif(sum(p.impressions) FILTER (WHERE p.date > last.last_date - 7), 0) AS position,
        sum(p.position * p.impressions) FILTER (WHERE p.date <= last.last_date - 7) / nullif(sum(p.impressions) FILTER (WHERE p.date <= last.last_date - 7), 0) AS prev_position,
        coalesce(sum(p.clicks) FILTER (WHERE p.date > last.last_date - 7), 0)::int AS clicks,
        coalesce(sum(p.impressions) FILTER (WHERE p.date > last.last_date - 7), 0)::int AS impressions,
        (array_agg(p.url ORDER BY p.date DESC) FILTER (WHERE p.url IS NOT NULL))[1] AS url
      FROM keyword_positions p
      WHERE p.keyword_id = k.id AND p.source = 'gsc' AND p.date > last.last_date - 14
    ) g ON last.last_date IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT position, url, serp_features, date FROM keyword_positions
      WHERE keyword_id = k.id AND source = 'dataforseo' ORDER BY date DESC LIMIT 1
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT volume, difficulty, cpc, created_at FROM keyword_ideas i
      WHERE i.project_id = k.project_id AND i.source = 'dataforseo' AND lower(i.idea) = lower(k.phrase)
        AND i.country = k.country AND i.locale = k.locale
      ORDER BY i.created_at DESC LIMIT 1
    ) m ON true
    WHERE k.project_id = ${projectId}
      AND ${filter.archived ? sql`k.archived_at IS NOT NULL` : sql`k.archived_at IS NULL`}
      ${filter.tag ? sql`AND ${filter.tag} = ANY(k.tags)` : sql``}
      ${filter.q ? sql`AND lower(k.phrase) LIKE ${`%${phraseKey(filter.q).replace(/[\\%_]/g, "\\$&")}%`}` : sql``}
    ORDER BY k.created_at DESC, k.id
  `);
  const items = (res.rows as unknown as ListRow[]).map((r): KeywordListItem => ({
    id: r.id,
    projectId: r.projectId,
    phrase: r.phrase,
    locale: r.locale,
    country: r.country,
    device: r.device,
    targetUrl: r.targetUrl,
    tags: r.tags,
    createdAt: r.createdAt,
    archivedAt: r.archivedAt,
    gsc: r.gsc_last_date
      ? {
          position: r.gsc_position === null ? null : round1(Number(r.gsc_position)),
          previousPosition: r.gsc_prev_position === null ? null : round1(Number(r.gsc_prev_position)),
          clicks: Number(r.gsc_clicks ?? 0),
          impressions: Number(r.gsc_impressions ?? 0),
          url: r.gsc_url,
          lastDate: r.gsc_last_date,
        }
      : null,
    serp: r.serp_date
      ? { position: r.serp_position, url: r.serp_url, features: r.serp_features ?? [], date: r.serp_date }
      : null,
    metrics: r.m_fetched_at
      ? { volume: r.m_volume, difficulty: r.m_difficulty, cpc: r.m_cpc, fetchedAt: new Date(r.m_fetched_at).toISOString() }
      : null,
  }));
  const tagRows = await db.execute<{ tag: string }>(sql`
    SELECT DISTINCT unnest(tags) AS tag FROM keywords WHERE project_id = ${projectId} ORDER BY 1
  `);
  return { keywords: items, tags: (tagRows.rows as Array<{ tag: string }>).map((t) => t.tag) };
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
