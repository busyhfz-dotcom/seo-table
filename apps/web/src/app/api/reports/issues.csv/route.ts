import { NextResponse } from "next/server";
import { NotFound } from "@seo/core";
import { handler } from "../../../../lib/route";
import { defaultProject, getProject, listIssues } from "../../../../lib/queries";

/**
 * Issue export. UTF-8 with a BOM so Excel opens Persian text correctly rather
 * than as mojibake, which is the single most common complaint about CSV exports.
 */
export const GET = handler({ permission: "report:read" }, async ({ req, session }) => {
  const projectId = req.nextUrl.searchParams.get("projectId");
  const project = projectId
    ? await getProject(session.orgId, projectId)
    : await defaultProject(session.orgId);
  if (!project) throw new NotFound("No project");

  const { rows } = await listIssues(project.id, { limit: 5000 });

  const header = [
    "severity",
    "rule_id",
    "category",
    "title",
    "status",
    "pages",
    "occurrences",
    "first_seen",
    "last_seen",
  ];
  const lines = [header.join(",")];
  for (const issue of rows) {
    lines.push(
      [
        issue.severity,
        issue.ruleId,
        issue.category,
        issue.title,
        issue.status,
        issue.pageCount,
        issue.occurrenceCount,
        issue.firstSeenAt.toISOString(),
        issue.lastSeenAt.toISOString(),
      ]
        .map(csvCell)
        .join(","),
    );
  }

  const body = `﻿${lines.join("\r\n")}\r\n`;
  return new NextResponse(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="seo-issues-${project.id}.csv"`,
      "cache-control": "no-store",
    },
  });
});

function csvCell(value: unknown): string {
  const s = String(value ?? "");
  // Guard against a leading =, +, - or @ being treated as a formula by a spreadsheet.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
