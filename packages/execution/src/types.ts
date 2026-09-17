export type SeoMode = 'INVISIBLE' | 'FULL_OPTIMIZATION' | 'FULL_AUTOPILOT';

export type ActionType =
  | 'META_TITLE'
  | 'META_DESCRIPTION'
  | 'CANONICAL'
  | 'SCHEMA'
  | 'IMAGE_ALT'
  | 'INTERNAL_LINK'
  | 'ROBOTS'
  | 'SITEMAP'
  | 'CONTENT_REWRITE'
  | 'REDIRECT'
  | 'URL_CHANGE'
  | 'PAGE_MERGE';

export type RiskLevel = 'SAFE' | 'REVIEW_REQUIRED' | 'BLOCKED';

export interface SeoAction {
  type: ActionType;
  targetUrl: string;
  payload: Record<string, unknown>;
}

export interface ExecutionDecision {
  allowed: boolean;
  requiresApproval: boolean;
  risk: RiskLevel;
  reason: string;
}

export interface ExecutionResult {
  success: boolean;
  actionId: string;
  message: string;
}
