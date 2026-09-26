import { NextResponse } from "next/server";
import { z } from "zod";
import { enforce, NotFound } from "@seo/core";
import { handler } from "../../../../lib/route";
import { getProject } from "../../../../lib/queries";
import { isLocale } from "../../../../lib/i18n";
import { callWorker, workerJson } from "../_lib/worker";

const schema = z.object({
  url: z.string().trim().min(1).max(2048),
  device: z.enum(["desktop", "mobile"]).default("desktop"),
  projectId: z.string().uuid().optional(),
});

/**
 * Open a remote browser session on the worker. 201 → {id, width, height, url,
 * title, loading, …}. A person has one session at a time: opening another
 * closes the previous one. 429 BROWSER_BUSY when every slot is taken, 503
 * BROWSER_UNAVAILABLE when the worker's browser is off or unreachable, 400
 * BLOCKED_ADDRESS for private and internal addresses.
 *
 * `scan:run` because the session spends server resources fetching third-party
 * sites on the organization's behalf, like a scan does. Browser sessions only:
 * an API key has no screen to drive it from.
 */
export const POST = handler({ permission: "scan:run", sessionOnly: true, schema }, async ({ req, session, body }) => {
  // Each session is a Chromium context: opening them must stay rare.
  await enforce(`browser:open:${session.userId}`, 6, 60_000, { failClosed: true });
  if (body.projectId && !(await getProject(session.orgId, body.projectId))) throw new NotFound("Project not found");
  const cookie = req.cookies.get("locale")?.value;
  const res = await callWorker("/sessions", {
    method: "POST",
    caller: session,
    body: { url: body.url, device: body.device, locale: isLocale(cookie) ? cookie : "fa" },
    timeoutMs: 45_000,
  });
  return NextResponse.json(await workerJson(res), { status: 201 });
});
