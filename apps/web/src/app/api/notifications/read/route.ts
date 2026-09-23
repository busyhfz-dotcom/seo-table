import { z } from "zod";
import { notificationService } from "@seo/seo-data";
import { handler } from "../../../../lib/route";

/** POST {ids: string[≤200]} → {updated} */
export const POST = handler(
  { permission: "project:read", schema: z.object({ ids: z.array(z.string().min(1).max(30)).min(1).max(200) }) },
  async ({ session, body }) => ({ updated: await notificationService.markRead(session.orgId, body.ids) }),
);
