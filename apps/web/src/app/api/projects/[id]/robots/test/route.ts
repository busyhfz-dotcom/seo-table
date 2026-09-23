import { z } from "zod";
import { robotsService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

const schema = z.object({
  urls: z.array(z.string().trim().max(2000)).min(1).max(100),
  userAgents: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
  /** Test an edited file instead of the live one. */
  robotsTxt: z.string().max(robotsService.MAX_ROBOTS_BYTES).optional(),
});

/**
 * POST {urls (paths or absolute URLs on the site), userAgents?, robotsTxt?} →
 * {results: [{url, userAgent, allowed, group, rule: {allow, pattern, line, text} | null}]}.
 * The verdict is the crawler's own robots.txt parser (RFC 9309).
 */
export const POST = handler({ permission: "project:read", schema }, async ({ session, params, body }) => {
  const project = await projectFor(session, params.id);
  const text = body.robotsTxt ?? (await robotsService.liveRobots(project.id)).body;
  const agents = body.userAgents?.length ? body.userAgents : robotsService.DEFAULT_AGENTS;
  const results = [];
  for (const raw of body.urls) {
    let url: string;
    try {
      url = new URL(raw, project.baseUrl).toString();
    } catch {
      continue;
    }
    for (const ua of agents) results.push(robotsService.explain(text, url, ua));
  }
  return { results };
});
