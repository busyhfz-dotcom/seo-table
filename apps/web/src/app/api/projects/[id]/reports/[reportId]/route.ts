import { recordAudit } from "@seo/core";
import { reportService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

export const DELETE = handler({ permission: "report:write" }, async ({ session, params, actor }) => {
  const project = await projectFor(session, params.id);
  await reportService.deleteReport(project.id, params.reportId!);
  await recordAudit({ orgId: session.orgId, actor, action: "report.delete", targetType: "report", targetId: params.reportId! });
  return { ok: true };
});
