import { NextResponse } from "next/server";
import { NotFound } from "@seo/core";
import { BRIDGE_PLUGIN_VERSION, bridgePluginZip } from "@seo/connectors";
import { handler } from "../../../../../../lib/route";
import { getProject } from "../../../../../../lib/queries";

/**
 * The SEO Table bridge plugin (the "plugin" approach), zipped for WordPress's
 * Plugins → Add New → Upload Plugin screen. It can also be copied into
 * wp-content/mu-plugins/ as a must-use plugin.
 */
export const GET = handler({ permission: "connector:read" }, async ({ session, params }) => {
  const project = await getProject(session.orgId, params.id!);
  if (!project) throw new NotFound("Project not found");
  return new NextResponse(Buffer.from(bridgePluginZip()), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="seo-table-bridge-${BRIDGE_PLUGIN_VERSION}.zip"`,
      "cache-control": "no-store",
    },
  });
});
