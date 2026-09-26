import { notificationService } from "@seo/seo-data";
import { handler, pagination } from "../../../lib/route";
import { projectFor } from "../../../lib/seo-data";

/**
 * GET ?page&perPage(≤200, default 20)&unread=1&projectId=
 * → {unread, total, page, perPage, items: [{id, projectId, kind, severity, title:{fa,en}, body:{fa,en}, link, data, deliveries, createdAt, readAt}]}
 * `unread` is the badge count (for the project when projectId is given).
 */
export const GET = handler({ permission: "project:read" }, async ({ req, session }) => {
  const { page, perPage } = pagination(req, 20);
  const projectId = req.nextUrl.searchParams.get("projectId") ?? undefined;
  if (projectId) await projectFor(session, projectId);
  return notificationService.listNotifications(session.orgId, {
    page,
    perPage,
    unreadOnly: req.nextUrl.searchParams.get("unread") === "1",
    projectId,
  });
});
