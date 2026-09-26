/**
 * Append-only audit log.
 *
 * Every state change an operator or the agent makes goes through `record`.
 * The table rejects UPDATE and DELETE at the database level (migration 0001),
 * so this is a ledger rather than a convenience log.
 */
import { db, auditLog } from "@seo/db";
import { logger } from "./logger.js";

export type ActorType = "USER" | "AGENT" | "SYSTEM" | "API_KEY";

export type Actor = { type: ActorType; id?: string | null; ip?: string | null };

export const AGENT: Actor = { type: "AGENT", id: "agent" };
export const SYSTEM: Actor = { type: "SYSTEM", id: "system" };

export type AuditAction =
  | "auth.login"
  | "auth.logout"
  | "auth.login_failed"
  | "project.create"
  | "project.update"
  | "project.delete"
  | "scan.enqueue"
  | "scan.start"
  | "scan.finish"
  | "scan.fail"
  | "scan.cancel"
  | "scan.refused_overlap"
  | "issue.ignore"
  | "fix.propose"
  | "fix.dry_run"
  | "fix.apply"
  | "fix.apply_blocked"
  | "fix.rollback"
  | "approval.request"
  | "approval.approve"
  | "approval.reject"
  | "connector.connect"
  | "connector.disconnect"
  | "connector.sync"
  | "connector.install_edge"
  | "connector.uninstall_edge"
  | "search_console.submit_sitemap"
  | "project.write_target"
  | "fixpack.download"
  | "member.role_change"
  | "apikey.create"
  | "apikey.revoke"
  | "auth.org_switch"
  | "report.create"
  | "keyword.add"
  | "keyword.update"
  | "keyword.archive"
  | "keyword.delete"
  | "keyword.research"
  | "rank.sync"
  | "pagespeed.run"
  | "competitor.add"
  | "competitor.update"
  | "competitor.delete"
  | "competitor.analyze"
  | "competitor.keyword_gap"
  | "schedule.update"
  | "alert.create"
  | "alert.update"
  | "alert.delete"
  | "alert.test"
  | "integration.connect"
  | "integration.disconnect"
  | "integration.test"
  | "content.create"
  | "content.update"
  | "content.delete"
  | "content.import"
  | "content.publish_request"
  | "content.publish"
  | "content.publish_reject"
  | "content.publish_rollback"
  | "schema.propose"
  | "robots.propose"
  | "sitemap.propose"
  | "report.delete"
  | "report.brand_update"
  | "social.oauth_start"
  | "social.connect"
  | "social.connect_failed"
  | "social.disconnect"
  | "social.check"
  | "social.sync"
  | "social.audit"
  | "social.settings_update"
  | "social.token_refresh"
  | "social.competitor_add"
  | "social.competitor_delete"
  | "social.competitor_refresh"
  | "social.post_create"
  | "social.post_update"
  | "social.post_submit"
  | "social.post_approve"
  | "social.post_reject"
  | "social.post_cancel"
  | "social.post_publish_now"
  | "social.post_published"
  | "social.post_failed";

export async function record(input: {
  orgId: string;
  actor: Actor;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(auditLog).values({
      orgId: input.orgId,
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      ip: input.actor.ip ?? null,
      metadata: input.metadata ?? null,
    });
  } catch (err) {
    // A failed audit write must be loud, but must not swallow the operation the
    // user asked for — the caller has already done the work by this point.
    logger.error(
      { err: (err as Error).message, action: input.action, orgId: input.orgId },
      "audit log write failed",
    );
  }
}
