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
  | "report.create";

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
