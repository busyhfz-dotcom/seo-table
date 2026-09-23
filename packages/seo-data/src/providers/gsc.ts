/**
 * Search Console as a data source. The seam the services depend on is this
 * small interface, so tests substitute a fake with real-shaped rows and the
 * product reads the project's connected property.
 */
import { forProjectOrNull, type SearchAnalyticsRequest, type SearchAnalyticsRow, type SearchConsoleClient } from "@seo/connectors";

export type { SearchAnalyticsRequest, SearchAnalyticsRow };

export type GscSource = {
  /** null when the project has no connected Search Console property. */
  query(projectId: string, req: SearchAnalyticsRequest): Promise<SearchAnalyticsRow[] | null>;
};

export const connectorGsc: GscSource = {
  async query(projectId, req) {
    const client = (await forProjectOrNull(projectId, "SEARCH_CONSOLE")) as SearchConsoleClient | null;
    if (!client) return null;
    return client.searchAnalytics(req);
  },
};
