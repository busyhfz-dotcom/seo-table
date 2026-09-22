import { NextResponse } from "next/server";
import { z } from "zod";
import { scanService, NotFound } from "@seo/core";
import { handler } from "../../../../../lib/route";
import { getProject, latestRunFor } from "../../../../../lib/queries";

// SCHEDULE and AGENT are the scheduler's and the agent's to claim; a caller
// saying so would put a manual crawl on record as automatic.
const schema = z.object({ trigger: z.enum(["MANUAL", "API"]).optional() });

/**
 * Start a scan.
 *
 * Send an `Idempotency-Key` header (1–255 visible ASCII characters) to make the
 * call safe to retry: the same key always returns the same run (200 rather than
 * 202) instead of queueing a second crawl. Without one, a key is generated per
 * request.
 *
 * 409 SCAN_ACTIVE means a scan is already active for this project — by design,
 * one at a time; `details.activeRunId` names it when known.
 */
export const POST = handler({ permission: "scan:run", schema }, async ({ req, session, params, body, actor, correlationId }) => {
  const project = await getProject(session.orgId, params.id!);
  if (!project) throw new NotFound("Project not found");

  const idempotencyKey = req.headers.get("idempotency-key") ?? undefined;
  const result = await scanService.createScan({
    projectId: project.id,
    orgId: session.orgId,
    actor,
    trigger: session.via === "api_key" ? "API" : (body.trigger ?? "MANUAL"),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    correlationId,
  });

  return NextResponse.json(
    { run: result.run, replayed: result.replayed },
    { status: result.replayed ? 200 : 202 },
  );
});

export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await getProject(session.orgId, params.id!);
  if (!project) throw new NotFound("Project not found");
  return { latestRun: await latestRunFor(project.id) };
});
