/** The shapes the /api/projects/:id/social/* routes answer with (see @seo/social). */
import type { Platform } from "./parts";

export type Pair = { fa: string; en: string };

export type Finding = {
  issueId: string;
  ruleId: string;
  category: string;
  severity: "CRITICAL" | "SERIOUS" | "WARNING" | "INFO";
  status: string;
  title: Pair;
  why: Pair | null;
  detail: Pair | null;
  manual: boolean;
  suggestion: { field: string; value: string | null } | null;
  firstSeenAt: string;
  lastSeenAt: string;
  proposal: { id: string; action: string; status: string; risk: string } | null;
};

export type AuditResult = {
  rules: Array<{ id: string; platform: Platform; category: string; title: Pair; why: Pair }>;
  run: { id: string; score: number | null; finishedAt: string | null; trigger: string } | null;
  score: number | null;
  hasData: boolean;
  findings: Finding[];
};

export type Metrics = { likes?: number; comments?: number; saves?: number; shares?: number; reach?: number; views?: number; interactions?: number };

export type PerPost = {
  id: string;
  externalId: string;
  permalink: string | null;
  type: string;
  publishedAt: string | null;
  caption: string | null;
  hashtags: string[];
  metrics: Metrics;
  source: "api" | "public_preview";
  interactions: number | null;
  erByReach: number | null;
  erByFollowers: number | null;
  viewRate: number | null;
};

export type Bucket = { key: number; posts: number; median: number };

export type Analytics = {
  platform: Platform;
  range: { from: string; to: string };
  timeZone: string;
  followers: { current: number | null; series: Array<{ date: string; followers: number; source: string }>; net: number | null; percent: number | null };
  daily: Array<{ date: string; reach: number | null; views: number | null; engagement: number | null }>;
  posts: { count: number; perWeek: number; byType: Record<string, number> };
  engagement: { averageViews?: number | null; averageViewRate?: number | null; averageErByReach?: number | null; averageErByFollowers?: number | null };
  topPosts: PerPost[];
  bestTimes: { timeZone: string; hours: Bucket[]; weekdays: Bucket[] };
  hashtags: Array<{ tag: string; posts: number; average: number; lift: number | null }>;
  formulas: Record<string, Pair>;
  sources: { followers: "api" | "public_preview" | null; views: "api" | "public_preview" };
};

export type PlannedPayload =
  | {
      op: "post";
      format: "image" | "carousel" | "reel" | "text" | "photo" | "album" | "video";
      text: string;
      media: Array<{ url: string; type: "image" | "video"; altText?: string | null }>;
      pin?: boolean;
      silent?: boolean;
      shareToFeed?: boolean;
    }
  | { op: "edit"; messageId: number; text: string; target: "text" | "caption" }
  | { op: "pin"; messageId: number; silent?: boolean };

export type PlannedPost = {
  id: string;
  platform: Platform;
  status: "draft" | "awaiting_approval" | "rejected" | "scheduled" | "publishing" | "published" | "failed" | "canceled";
  publishAt: string | null;
  payload: PlannedPayload;
  requestedAt: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  attempts: number;
  publishedAt: string | null;
  resultPermalink: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Competitor = {
  id: string;
  username: string;
  status: "pending" | "ok" | "unsupported" | "not_found" | "no_public_preview" | "error";
  statusText: Pair | null;
  snapshot: {
    source: "business_discovery" | "public_preview";
    name: string | null;
    followers: number | null;
    mediaCount: number | null;
    recent: Array<{ at: string | null }>;
    postsPerWeek: number | null;
    avgViews: number | null;
    avgInteractions: number | null;
  } | null;
  fetchedAt: string | null;
};
