/** The keyword API's JSON, as the screen receives it (dates are strings). */

export type KeywordRow = {
  id: string;
  phrase: string;
  locale: string;
  country: string;
  device: "desktop" | "mobile" | null;
  targetUrl: string | null;
  tags: string[];
  createdAt: string;
  archivedAt: string | null;
  gsc: {
    position: number | null;
    previousPosition: number | null;
    clicks: number;
    impressions: number;
    url: string | null;
    lastDate: string | null;
  } | null;
  serp: { position: number | null; url: string | null; features: string[]; date: string } | null;
  metrics: { volume: number | null; difficulty: number | null; cpc: number | null; fetchedAt: string } | null;
};

export type KeywordList = {
  keywords: KeywordRow[];
  tags: string[];
  sources: { gsc: boolean; dataforseo: boolean; pagespeedKey: string };
};

export type Point = {
  date: string;
  source: "gsc" | "dataforseo";
  position: number | null;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  url: string | null;
  serpFeatures: string[] | null;
};

export type Mover = {
  keywordId: string;
  phrase: string;
  position: number | null;
  previousPosition: number | null;
  change: number | null;
  impressions: number;
};

export type Movers = {
  source: "gsc" | "dataforseo";
  current: { from: string; to: string } | null;
  previous: { from: string; to: string } | null;
  gains: Mover[];
  losses: Mover[];
};

export type Visibility = {
  from: string;
  to: string;
  formula: string;
  source: "gsc";
  series: Array<{ date: string; visibility: number; clicks: number; impressions: number; keywords: number }>;
};

export type NotConfigured = { configured: false };

export type Opportunities =
  | NotConfigured
  | {
      configured: true;
      source: "gsc";
      from: string;
      to: string;
      items: Array<{ query: string; clicks: number; impressions: number; ctr: number; position: number; potentialClicks: number }>;
    };

export type Suggestions = {
  source: "autocomplete";
  volumeData: false;
  seed: string;
  cached: boolean;
  items: Array<{ idea: string; tracked: boolean }>;
};

export type Ideas =
  | NotConfigured
  | {
      configured: true;
      source: "dataforseo";
      cached: boolean;
      cost: number | null;
      currency: "USD";
      items: Array<{ idea: string; volume: number | null; difficulty: number | null; cpc: number | null; tracked: boolean }>;
    };

export type MappingItem = {
  keywordId: string;
  phrase: string;
  targetUrl: string | null;
  rankingUrl: string | null;
  rankingSource: "gsc" | "dataforseo" | null;
  matches: boolean | null;
};

export type Cannibalization =
  | NotConfigured
  | {
      configured: true;
      source: "gsc";
      from: string;
      to: string;
      items: Array<{
        query: string;
        tracked: boolean;
        impressions: number;
        clicks: number;
        pages: Array<{ url: string; impressions: number; clicks: number; position: number; share: number }>;
      }>;
    };

/** What every panel on the screen shares. */
export type Ctx = {
  projectId: string;
  baseUrl: string;
  locale: "fa" | "en";
  canWrite: boolean;
  sources: { gsc: boolean; dataforseo: boolean };
  links: { connectGsc: string; integrations: string | null; audit: string };
  countries: Array<{ code: string; name: string }>;
};
