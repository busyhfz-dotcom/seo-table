import { z } from "zod";
import { notificationService } from "@seo/seo-data";
import { handler } from "../../../../lib/route";
import { projectFor } from "../../../../lib/seo-data";

/** POST {projectId?} → {updated} */
export const POST = handler(
  { permission: "project:read", schema: z.object({ projectId: z.string().min(1).max(30).optional() }) },
  async ({ session, body }) => {
    if (body.projectId) await projectFor(session, body.projectId);
    return { updated: await notificationService.markAllRead(session.orgId, body.projectId) };
  },
);
