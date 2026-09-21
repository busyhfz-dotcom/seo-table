import { NextResponse } from "next/server";
import { z } from "zod";
import { db, projects, connectors } from "@seo/db";
import { recordAudit } from "@seo/core";
import { handler } from "../../../lib/route";
import { listProjects } from "../../../lib/queries";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  baseUrl: z.string().url().refine((u) => /^https?:\/\//.test(u), "must be an http(s) URL"),
  locale: z.enum(["fa", "en"]).default("fa"),
  pageCap: z.coerce.number().int().min(1).max(50_000).default(2000),
  crawlRate: z.coerce.number().int().min(1).max(50).default(8),
});

export const GET = handler({ permission: "project:read" }, async ({ session }) => ({
  projects: await listProjects(session.orgId),
}));

export const POST = handler(
  { permission: "project:write", schema: createSchema },
  async ({ session, body, ip }) => {
    const project = (
      await db
        .insert(projects)
        .values({
          orgId: session.orgId,
          name: body.name,
          baseUrl: body.baseUrl.replace(/\/+$/, ""),
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
        (["WORDPRESS", "SEARCH_CONSOLE", "GA4", "INSTAGRAM", "YOUTUBE"] as const).map((kind) => ({
          projectId: project.id,
          kind,
          status: "NOT_CONNECTED" as const,
        })),
      )
      .onConflictDoNothing();

    await recordAudit({
      orgId: session.orgId,
      actor: { type: "USER", id: session.userId, ip },
      action: "project.create",
      targetType: "project",
      targetId: project.id,
      metadata: { baseUrl: project.baseUrl },
    });

    return NextResponse.json({ project }, { status: 201 });
  },
);
