import { NextResponse } from "next/server";
import { z } from "zod";
import { scanService, NotFound } from "@seo/core";
import { handler } from "../../../../../lib/route";
import { getProject } from "../../../../../lib/queries";

const schema = z.object({ trigger: z.enum(["MANUAL", "API", "SCHEDULE"]).default("MANUAL") });

/**
 * Start a scan.
 *
 * Send an `Idempotency-Key` header to make the call safe to retry: the same key
 * always returns the same run (200 rather than 201) instead of queueing a second
 * crawl. Without one, a key is generated per request.
 *
 * 409 means a scan is already active for this project — by design, one at a time.
 */
export const POST = handler({ permission: "scan:run", schema }, async ({ req, session, params, body, ip, correlationId }) => {
  const project = await getProject(session.orgId, params.id!);
  if (!project) throw new NotFound("Project not found");

  const idempotencyKey = req.headers.get("idempotency-key") ?? undefined;
  const result = await scanService.createScan({
    projectId: project.id,
    orgId: session.orgId,
    actor: { type: session.userId.startsWith("apikey:") ? "API_KEY" : "USER", id: session.userId, ip },
    trigger: body.trigger,
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
  const { latestRunFor } = await import("../../../../../lib/queries");
  return { latestRun: await latestRunFor(project.id) };
});
