import { recordAudit } from "@seo/core";
import { scheduleService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

/**
 * PUT {cron?, timezone?, enabled?} → {schedule}. 400 with details.field
 * ("cron" | "timezone") for an invalid cron, an unknown zone, or a schedule
 * that would run more than once an hour.
 */
export const PUT = handler(
  { permission: "project:write", schema: scheduleService.updateScheduleInput },
  async ({ session, params, body, actor }) => {
    const project = await projectFor(session, params.id);
    const kind = scheduleService.scheduleKind(params.kind);
    const schedule = await scheduleService.updateSchedule(project.id, kind, body);
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: "schedule.update",
      targetType: "schedule",
      targetId: schedule.id,
      metadata: { kind, cron: schedule.cron, timezone: schedule.timezone, enabled: schedule.enabled },
    });
    return { schedule };
  },
);
