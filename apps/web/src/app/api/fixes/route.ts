import { NotFound } from "@seo/core";
import { handler } from "../../../lib/route";
import { defaultProject, getProject, listFixes } from "../../../lib/queries";
import type { FixStatus } from "@seo/db";

const VALID: FixStatus[] = [
  "DRAFT",
  "AWAITING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "APPLYING",
  "APPLIED",
  "FAILED",
  "ROLLED_BACK",
];

export const GET = handler({ permission: "issue:read" }, async ({ req, session }) => {
  const projectId = req.nextUrl.searchParams.get("projectId");
  const project = projectId
    ? await getProject(session.orgId, projectId)
    : await defaultProject(session.orgId);
  if (!project) throw new NotFound("No project to read fixes for");

  const requested = (req.nextUrl.searchParams.get("status") ?? "")
    .split(",")
    .filter((s): s is FixStatus => VALID.includes(s as FixStatus));

  return { projectId: project.id, fixes: await listFixes(project.id, requested.length ? requested : undefined) };
});
