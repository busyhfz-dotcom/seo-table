import { pagespeedService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { dateRange, projectFor } from "../../../../../../lib/seo-data";

/** GET ?url=&strategy=mobile|desktop&from&to (default 90 days) → measurements with CWV assessment, oldest first. */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await projectFor(session, params.id);
  const range = dateRange(req, 90);
  const p = req.nextUrl.searchParams;
  const strategy = p.get("strategy");
  return {
    ...range,
    items: await pagespeedService.history(project.id, {
      url: p.get("url") ?? undefined,
      strategy: strategy === "mobile" || strategy === "desktop" ? strategy : undefined,
      from: new Date(`${range.from}T00:00:00Z`),
      to: new Date(`${range.to}T23:59:59.999Z`),
    }),
  };
});
