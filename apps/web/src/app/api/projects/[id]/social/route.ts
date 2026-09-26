import { recordAudit } from "@seo/core";
import { socialAccounts } from "@seo/social";
import { handler } from "../../../../../lib/route";
import { socialProjectFor } from "../../../../../lib/social";

/**
 * GET → the project's social account: {platform, account, instagramConfigured,
 * capabilities}. No token or hint of one is ever included.
 * PATCH {keywords?, cta?, link?, timezone?} → {account}: what the audit judges against.
 */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await socialProjectFor(session, params.id);
  const row = await socialAccounts.ensureAccount(project.id, project.kind as "INSTAGRAM" | "TELEGRAM");
  const ig = project.kind === "INSTAGRAM";
  return {
    platform: project.kind,
    account: socialAccounts.accountView(row),
    instagramConfigured: ig ? socialAccounts.instagramApp() !== null : null,
    capabilities: ig
      ? {
          editProfile: false,
          publish: ["image", "carousel", "reel"],
          editPosts: false,
          pin: false,
          competitors: row.profile.businessDiscovery ?? null,
          notes: ["instagram_profile_manual", "instagram_competitors_business_discovery"],
        }
      : {
          editProfile: Boolean(row.profile.rights?.can_change_info),
          publish: ["text", "photo", "album", "video"],
          editPosts: Boolean(row.profile.rights?.can_edit_messages),
          pin: Boolean(row.profile.rights?.can_edit_messages),
          competitors: true,
          views: row.profile.publicPreview ?? null,
          notes: ["telegram_username_manual", "telegram_views_public_preview"],
        },
  };
});

export const PATCH = handler({ permission: "social:write", schema: socialAccounts.settingsInput }, async ({ session, params, body, actor }) => {
  const project = await socialProjectFor(session, params.id);
  await socialAccounts.ensureAccount(project.id, project.kind as "INSTAGRAM" | "TELEGRAM");
  const row = await socialAccounts.updateSettings(project.id, body);
  await recordAudit({
    orgId: session.orgId,
    actor,
    action: "social.settings_update",
    targetType: "project",
    targetId: project.id,
    metadata: { keywords: row.settings.keywords?.length ?? 0, cta: Boolean(row.settings.cta), link: Boolean(row.settings.link) },
  });
  return { account: socialAccounts.accountView(row) };
});
