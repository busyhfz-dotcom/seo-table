import { scheduleService } from "@seo/seo-data";
import { handler } from "../../../../../lib/route";
import { projectFor } from "../../../../../lib/seo-data";

/**
 * GET → {schedules: [{kind, cron, timezone, enabled, lastRunAt, nextRunAt, lastError}]}
 * for scan, rank, pagespeed, competitors, report. Cron is five-field, evaluated
 * in `timezone`; nextRunAt is UTC.
 */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await projectFor(session, params.id);
  return { schedules: await scheduleService.listSchedules(project.id) };
});
