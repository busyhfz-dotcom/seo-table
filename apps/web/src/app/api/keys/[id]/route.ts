import { and, apiKeys, db, eq, isNull } from "@seo/db";
import { NotFound, recordAudit } from "@seo/core";
import { handler } from "../../../../lib/route";

/**
 * Revoke an API key. The row stays (with `revokedAt`) so the audit trail and the
 * key list keep saying which key did what. Revoking twice is not an error: the
 * second call reports the original revocation time.
 */
export const DELETE = handler({ permission: "apikey:manage" }, async ({ session, params, actor }) => {
  const scope = and(eq(apiKeys.id, params.id!), eq(apiKeys.orgId, session.orgId));
  const [revoked] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(scope, isNull(apiKeys.revokedAt)))
    .returning();

  if (revoked) {
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: "apikey.revoke",
      targetType: "api_key",
      targetId: revoked.id,
      metadata: { name: revoked.name },
    });
    return { id: revoked.id, revokedAt: revoked.revokedAt };
  }

  const [existing] = await db.select().from(apiKeys).where(scope).limit(1);
  if (!existing) throw new NotFound("API key not found");
  return { id: existing.id, revokedAt: existing.revokedAt };
});
