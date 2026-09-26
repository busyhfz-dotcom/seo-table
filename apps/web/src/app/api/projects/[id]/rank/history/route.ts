import { rankService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { dateRange, projectFor } from "../../../../../../lib/seo-data";

/**
 * GET ?from&to (default 28 days) &source=gsc|dataforseo &keywordIds=a,b
 * → {from, to, keywords: [{keywordId, phrase, series: [{date, source, position, clicks, impressions, ctr, url, serpFeatures}]}]}
 */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await projectFor(session, params.id);
  const range = dateRange(req, 28);
  const p = req.nextUrl.searchParams;
  const source = p.get("source");
  const keywordIds = (p.get("keywordIds") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500);
  return {
    ...range,
    keywords: await rankService.history(project.id, {
      ...range,
      keywordIds: keywordIds.length ? keywordIds : undefined,
      source: source === "gsc" || source === "dataforseo" ? source : undefined,
    }),
  };
});
