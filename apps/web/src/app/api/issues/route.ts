import { NotFound } from "@seo/core";
import { handler, pagination } from "../../../lib/route";
import { defaultProject, getProject, listIssues } from "../../../lib/queries";
import type { Severity } from "@seo/db";

export const GET = handler({ permission: "issue:read" }, async ({ req, session }) => {
  const projectId = req.nextUrl.searchParams.get("projectId");
  const project = projectId
    ? await getProject(session.orgId, projectId)
    : await defaultProject(session.orgId);
  if (!project) throw new NotFound("No project to read issues for");

  const { limit, offset, page, perPage } = pagination(req);
  const sev = req.nextUrl.searchParams.get("severity");
  const status = req.nextUrl.searchParams.get("status");

  const { rows, total } = await listIssues(project.id, {
    ...(sev && ["CRITICAL", "SERIOUS", "WARNING", "INFO"].includes(sev)
      ? { severity: sev as Severity }
      : {}),
    ...(status && ["OPEN", "FIXED", "IGNORED"].includes(status)
      ? { status: status as "OPEN" | "FIXED" | "IGNORED" }
      : {}),
    ...(req.nextUrl.searchParams.get("category")
      ? { category: req.nextUrl.searchParams.get("category")! }
      : {}),
    ...(req.nextUrl.searchParams.get("q") ? { q: req.nextUrl.searchParams.get("q")! } : {}),
    limit,
    offset,
  });

  return { projectId: project.id, page, perPage, total, issues: rows };
});
