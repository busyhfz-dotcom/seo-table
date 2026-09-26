/**
 * Server-side names of the Instagram / Telegram audit rules, for screens shared
 * with websites (fixes, approvals) whose client-safe label tables do not carry
 * them.
 */
import { socialRule } from "@seo/social";
import type { Locale } from "./i18n";
import { ruleName, ruleTitle } from "./labels";

export function anyRuleName(ruleId: string, locale: Locale): string {
  return socialRule(ruleId)?.title[locale] ?? ruleName(ruleId, locale);
}

export function anyRuleTitle(ruleId: string, fallback: string, locale: Locale): string {
  return socialRule(ruleId)?.title[locale] ?? ruleTitle(ruleId, fallback, locale);
}
