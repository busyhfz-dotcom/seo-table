import { scanService, NotFound } from "@seo/core";
import { handler } from "../../../../../lib/route";
import { getRun } from "../../../../../lib/queries";

export const POST = handler({ permission: "scan:cancel" }, async ({ session, params, actor }) => {
  const run = await getRun(session.orgId, params.id!);
  if (!run) throw new NotFound("Run not found");
  const updated = await scanService.cancelScan({
    runId: run.id,
    orgId: session.orgId,
    actor,
  });
  return { run: updated };
});
