import { applyTarget, robotsService } from "@seo/seo-data";
import { handler } from "../../../../../lib/route";
import { projectFor } from "../../../../../lib/seo-data";

/**
 * GET → {file: {url, state: "ok"|"missing"|"unreachable", status, body}, issues,
 * suggested (a starting file when the site has none, else null), apply: {target,
 * connected, supported, notes}} — whether the write target can serve an edited file.
 */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await projectFor(session, params.id);
  const [file, apply] = await Promise.all([robotsService.liveRobots(project.id), applyTarget(project.id, "ROBOTS_TXT")]);
  return {
    file,
    issues: file.state === "ok" ? robotsService.validateRobots(file.body, project.baseUrl) : [],
    suggested: file.state === "ok" ? null : robotsService.defaultRobots(project.baseUrl),
    apply,
  };
});
