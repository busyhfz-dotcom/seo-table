import { rankService } from "@seo/seo-data";
import { handler } from "../../../../../../../lib/route";
import { dateRange, projectFor } from "../../../../../../../lib/seo-data";

/** GET ?from&to (default 90 days) → {keyword: {keywordId, phrase, series[]} | null}; both sources, labelled per point. */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await projectFor(session, params.id);
  const range = dateRange(req, 90);
  const [keyword] = await rankService.history(project.id, { ...range, keywordIds: [params.keywordId!] });
  return { ...range, keyword: keyword ?? null };
});
