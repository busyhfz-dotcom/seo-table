/**
 * Seed the minimum a real deployment needs: one organization, one owner, and the
 * connector rows for the project's five integrations.
 *
 * This creates *accounts*, not fake content. No scans, issues, opportunities or
 * fixes are invented — those only ever come from a real crawl or a real
 * connector, which is the point.
 *
 * Usage:
 *   SEED_EMAIL=you@example.com SEED_PASSWORD='…' SEED_SITE=https://example.ir pnpm tsx scripts/seed.ts
 */
import {
  connectors,
  db,
  eq,
  memberships,
  organizations,
  projects,
  users,
  closeDb,
} from "@seo/db";
import { hashPassword, recordAudit } from "@seo/core";

const email = (process.env.SEED_EMAIL ?? "owner@example.com").toLowerCase();
const password = process.env.SEED_PASSWORD ?? "";
const orgName = process.env.SEED_ORG ?? "SEO Table";
const site = process.env.SEED_SITE ?? "";
const projectName = process.env.SEED_PROJECT ?? "First project";

async function main(): Promise<void> {
  if (!password || password.length < 10) {
    throw new Error("Set SEED_PASSWORD to at least 10 characters; no default password is created.");
  }

  // Bootstrap mode (container start): only ever creates the *first* account. Once
  // any user exists this is a no-op, so leaving the variables set cannot be used
  // to reset a password or plant a second owner.
  if (process.env.SEED_ONLY_IF_EMPTY === "1") {
    const any = await db.select({ id: users.id }).from(users).limit(1);
    if (any.length > 0) {
      console.log("[seed] users already exist; bootstrap skipped");
      return;
    }
  }

  const existing = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  if (existing) {
    console.log(`[seed] user ${email} already exists (${existing.id}); nothing to do`);
    return;
  }

  const org = (
    await db
      .insert(organizations)
      .values({ name: orgName, slug: slugify(orgName) })
      .returning()
  )[0]!;

  const user = (
    await db
      .insert(users)
      .values({ email, name: process.env.SEED_NAME ?? null, passwordHash: await hashPassword(password) })
      .returning()
  )[0]!;

  await db.insert(memberships).values({ userId: user.id, orgId: org.id, role: "OWNER" });

  let projectId: string | null = null;
  if (site) {
    const project = (
      await db
        .insert(projects)
        .values({
          orgId: org.id,
          name: projectName,
          baseUrl: site.replace(/\/+$/, ""),
          locale: process.env.SEED_LOCALE === "en" ? "en" : "fa",
          pageCap: Number(process.env.SEED_PAGE_CAP ?? 2000),
          crawlRate: Number(process.env.SEED_CRAWL_RATE ?? 8),
        })
        .returning()
    )[0]!;
    projectId = project.id;

    await db.insert(connectors).values(
      (["WORDPRESS", "SEARCH_CONSOLE", "GA4", "INSTAGRAM", "YOUTUBE"] as const).map((kind) => ({
        projectId: project.id,
        kind,
        status: "NOT_CONNECTED" as const,
      })),
    );
  }

  await recordAudit({
    orgId: org.id,
    actor: { type: "SYSTEM", id: "seed" },
    action: "project.create",
    targetType: "organization",
    targetId: org.id,
    metadata: { seeded: true, email, projectId },
  });

  console.log(
    [
      "[seed] created:",
      `  organization ${org.name} (${org.id})`,
      `  owner        ${email} (${user.id})`,
      projectId ? `  project      ${projectName} → ${site} (${projectId})` : "  project      none (set SEED_SITE to create one)",
      "",
      "No scan data was created. Run a scan to populate the product with real findings.",
    ].join("\n"),
  );
}

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || `org-${Date.now().toString(36)}`;
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("[seed] failed:", err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
