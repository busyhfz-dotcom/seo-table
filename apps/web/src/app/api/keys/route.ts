import { NextResponse } from "next/server";
import { z } from "zod";
import { apiKeys, db, desc, eq } from "@seo/db";
import { recordAudit } from "@seo/core";
import { handler } from "../../../lib/route";
import { newApiKey } from "../../../lib/auth";

const schema = z.object({ name: z.string().trim().min(1).max(60) });

export const GET = handler({ permission: "apikey:manage" }, async ({ session }) => {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.orgId, session.orgId))
    .orderBy(desc(apiKeys.createdAt))
    .limit(100);
  // The secret is never readable again after creation; only its prefix is shown.
  return {
    keys: rows.map((k) => ({
      id: k.id,
      name: k.name,
      masked: `st_${k.prefix}_${"•".repeat(8)}`,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      revokedAt: k.revokedAt,
    })),
  };
});

export const POST = handler({ permission: "apikey:manage", schema }, async ({ session, body, actor }) => {
  const key = newApiKey();
  const row = (
    await db
      .insert(apiKeys)
      .values({ orgId: session.orgId, name: body.name, prefix: key.prefix, hash: key.hash })
      .returning()
  )[0]!;

  await recordAudit({
    orgId: session.orgId,
    actor,
    action: "apikey.create",
    targetType: "api_key",
    targetId: row.id,
    metadata: { name: body.name },
  });

  // Shown exactly once, on creation. Nothing stores it in a readable form.
  return NextResponse.json({ id: row.id, name: row.name, secret: key.display }, { status: 201 });
});
