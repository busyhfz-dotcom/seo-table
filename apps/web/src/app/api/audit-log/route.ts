import { handler, pagination } from "../../../lib/route";
import { listAuditLog } from "../../../lib/queries";

export const GET = handler({ permission: "auditlog:read" }, async ({ req, session }) => {
  const { limit } = pagination(req, 100);
  return { entries: await listAuditLog(session.orgId, limit) };
});
