import { reportService } from "@seo/seo-data";
import { handler } from "../../../../../../../lib/route";
import { projectFor } from "../../../../../../../lib/seo-data";

/** GET → {jobId, kind, state ("waiting"|"active"|"completed"|"failed"|…), queuedAt, reportId, error}. */
export const GET = handler({ permission: "report:read" }, async ({ session, params }) => {
  const project = await projectFor(session, params.id);
  return reportService.jobStatus(project.id, params.jobId!);
});
