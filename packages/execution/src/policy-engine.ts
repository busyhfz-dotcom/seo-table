import type { ActionType, ExecutionDecision, SeoAction, SeoMode } from './types';

const safe = new Set<ActionType>(['META_TITLE', 'META_DESCRIPTION', 'SCHEMA', 'IMAGE_ALT']);
const review = new Set<ActionType>(['CANONICAL', 'INTERNAL_LINK', 'ROBOTS', 'SITEMAP', 'CONTENT_REWRITE']);
const destructive = new Set<ActionType>(['REDIRECT', 'URL_CHANGE', 'PAGE_MERGE']);

export function evaluatePolicy(action: SeoAction | ActionType, mode: SeoMode): ExecutionDecision {
  const type = typeof action === 'string' ? action : action.type;

  if (destructive.has(type)) {
    return { allowed: true, requiresApproval: true, risk: 'REVIEW_REQUIRED', reason: `${type} can change URLs, indexing or information architecture and always requires explicit approval.` };
  }

  if (review.has(type)) {
    return { allowed: true, requiresApproval: true, risk: 'REVIEW_REQUIRED', reason: `${type} can materially affect crawl or page meaning and requires review before execution.` };
  }

  if (safe.has(type)) {
    return { allowed: true, requiresApproval: false, risk: 'SAFE', reason: `${type} is eligible for low-risk automatic execution with audit logging and rollback metadata.` };
  }

  if (mode === 'INVISIBLE') {
    return { allowed: false, requiresApproval: false, risk: 'BLOCKED', reason: `${type} is outside Invisible Mode's safe-change policy.` };
  }

  return { allowed: true, requiresApproval: true, risk: 'REVIEW_REQUIRED', reason: `${type} is not classified as safe and defaults to approval-required.` };
}

export function canExecute(action: SeoAction | ActionType, mode: SeoMode): boolean {
  const decision = evaluatePolicy(action, mode);
  return decision.allowed && !decision.requiresApproval;
}
