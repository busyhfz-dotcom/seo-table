import { NotFound } from "@seo/core";
import { handler } from "../../../lib/route";
import { defaultProject, getProject, listApprovalQueue } from "../../../lib/queries";

export const GET = handler({ permission: "issue:read" }, async ({ req, session }) => {
  const projectId = req.nextUrl.searchParams.get("projectId");
  const project = projectId
    ? await getProject(session.orgId, projectId)
    : await defaultProject(session.orgId);
  if (!project) throw new NotFound("No project");
  const rows = await listApprovalQueue(project.id);
  return {
    projectId: project.id,
    queue: rows.map((r) => ({
      proposal: r.proposal,
      approval: r.approval,
      issueTitle: r.issue?.title ?? null,
    })),
  };
});
