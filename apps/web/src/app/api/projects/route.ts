import { NextResponse } from "next/server";
import { z } from "zod";
import { db, projects, connectors } from "@seo/db";
import { assertPublicUrl, recordAudit } from "@seo/core";
import { refreshPlatform } from "@seo/connectors";
import { handler } from "../../../lib/route";
import { listProjects } from "../../../lib/queries";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  baseUrl: z.string().trim().max(2000).url().refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL"),
  locale: z.enum(["fa", "en"]).default("fa"),
  pageCap: z.coerce.number().int().min(1).max(50_000).default(2000),
  crawlRate: z.coerce.number().int().min(1).max(50).default(8),
});

export const GET = handler({ permission: "project:read" }, async ({ session }) => ({
  projects: await listProjects(session.orgId),
}));

export const POST = handler(
  { permission: "project:write", schema: createSchema },
  async ({ session, body, actor }) => {
    const baseUrl = storedBaseUrl(body.baseUrl);
    // Refused here with a clear 400 BLOCKED_ADDRESS; the crawler checks every
    // fetch again, since DNS can change after the project is created.
    await assertPublicUrl(baseUrl);

    const project = (
      await db
        .insert(projects)
        .values({
          orgId: session.orgId,
          name: body.name,
          baseUrl,
          locale: body.locale,
          pageCap: body.pageCap,
          crawlRate: body.crawlRate,
        })
        .returning()
    )[0]!;

    // Every connector kind gets a row up front, so the Connectors screen is a
    // complete list of what is possible rather than only what exists.
    await db
      .insert(connectors)
      .values(
        (["WORDPRESS", "CLOUDFLARE", "SEARCH_CONSOLE", "GA4", "INSTAGRAM", "YOUTUBE"] as const).map((kind) => ({
          projectId: project.id,
          kind,
          status: "NOT_CONNECTED" as const,
        })),
      )
      .onConflictDoNothing();

    // Detecting the CMS/CDN decides which connection methods the panel
    // recommends. Best effort and not awaited: a slow site must not delay the
    // response, and the first scan detects it anyway.
    void refreshPlatform(project.id).catch(() => undefined);

    await recordAudit({
      orgId: session.orgId,
      actor,
      action: "project.create",
      targetType: "project",
      targetId: project.id,
      metadata: { baseUrl: project.baseUrl },
    });

    return NextResponse.json({ project }, { status: 201 });
  },
);

/**
 * The URL as typed, path and trailing slash included — "https://a.example/blog/"
 * and "https://a.example/blog" can be different pages — with only what cannot
 * matter normalized: the fragment dropped and scheme/host lowercased.
 */
function storedBaseUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  return url.toString();
}
