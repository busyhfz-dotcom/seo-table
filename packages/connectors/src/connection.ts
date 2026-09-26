/**
 * Every way this project's site can receive fixes, what each can do right now,
 * and which one the panel recommends — from the stored platform detection and
 * the connectors' last checks, so reading it calls no one.
 *
 * Methods:
 *   CLOUDFLARE        no install — the edge worker rewrites pages at Cloudflare
 *   WORDPRESS         no install — REST API with an application password, and the
 *                     site's own SEO plugin API (Rank Math, SEOPress, AIOSEO)
 *   WORDPRESS_BRIDGE  plugin — the SEO Table bridge plugin on the site
 *   FIX_PACK          no install — files to apply by hand; always available
 *
 * Notes are stable English sentences; the web layer translates them.
 */
import { connectors, db, eq, projects, type Connector as ConnectorRow, type PlatformInfo, type WriteTarget } from "@seo/db";
import { BadRequest, NotFound } from "@seo/core";
import type { ConnectorCapabilities } from "./types.js";
import { resolveWriteTarget, type ResolvedWriteTarget } from "./write-target.js";
import { SEO_PLUGIN_LABELS } from "./wp-seo-plugins.js";

export type ConnectionMethodKind = "CLOUDFLARE" | "WORDPRESS" | "WORDPRESS_BRIDGE" | "FIX_PACK";
export type ConnectionMethodStatus =
  | "connected"
  | "needs_install"
  | "not_installed"
  | "not_connected"
  | "error"
  | "not_applicable"
  | "available";

export type ConnectionMethod = {
  kind: ConnectionMethodKind;
  approach: "no_install" | "plugin";
  status: ConnectionMethodStatus;
  capabilities: ConnectorCapabilities | null;
  notes: string[];
  recommended: boolean;
  lastError: string | null;
  /** Cloudflare only: {zone, hosts, installed, outdated, conflicts} from the last check. */
  detail: Record<string, unknown> | null;
};

export type ConnectionOverview = {
  platform: PlatformInfo | null;
  writeTarget: { configured: ResolvedWriteTarget["configured"]; effective: WriteTarget; source: ResolvedWriteTarget["source"] };
  methods: ConnectionMethod[];
  /** About the overview as a whole, e.g. that the platform is not detected yet. */
  notes: string[];
};

type StoredConfig = { capabilities?: ConnectorCapabilities | null; detail?: Record<string, unknown> | null };

const WRITABLE_SEO_PLUGINS = new Set(["rankmath", "seopress", "aioseo"]);

export async function connectionOverview(projectId: string): Promise<ConnectionOverview> {
  const project = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!project) throw new NotFound("Project not found");
  const rows = await db.select().from(connectors).where(eq(connectors.projectId, projectId));
  const row = (kind: ConnectorRow["kind"]) => rows.find((r) => r.kind === kind);
  const config = (r: ConnectorRow | undefined) => (r?.config ?? {}) as StoredConfig;
  // Website connection methods mean nothing for an Instagram or Telegram project.
  if (project.kind !== "WEBSITE") throw new BadRequest("This project is not a website", { reason: "not_a_website" });
  const resolved = await resolveWriteTarget(projectId);
  const target = { ...resolved, kind: resolved.kind as WriteTarget };
  const platform = project.platform ?? null;

  const isWordPress = platform ? platform.cms === "wordpress" : null;
  const behindCloudflare = platform ? platform.cdn === "cloudflare" : null;

  // ---- Cloudflare
  const cf = row("CLOUDFLARE");
  const cfDetail = config(cf).detail ?? null;
  const cfStatus: ConnectionMethodStatus =
    cf?.status === "CONNECTED" ? (cfDetail?.installed ? "connected" : "needs_install") : cf?.status === "ERROR" ? "error" : "not_connected";
  const cfNotes: string[] = [];
  if (behindCloudflare === false && cfStatus === "not_connected") {
    cfNotes.push("The site is not behind Cloudflare: move the domain's DNS to Cloudflare (the free plan is enough) to apply fixes at the edge.");
  }

  // ---- WordPress (no install) and the bridge plugin
  const wp = row("WORDPRESS");
  const wpCaps = config(wp).capabilities ?? null;
  const bridgeActive = Boolean(wpCaps?.writableFields.includes("redirect"));
  const wpApplicable = isWordPress !== false || wp?.status === "CONNECTED";
  const wpStatus: ConnectionMethodStatus =
    wp?.status === "CONNECTED" ? "connected" : wp?.status === "ERROR" ? "error" : wpApplicable ? "not_connected" : "not_applicable";
  const bridgeStatus: ConnectionMethodStatus =
    wp?.status === "CONNECTED" ? (bridgeActive ? "connected" : "not_installed") : wpApplicable ? "not_connected" : "not_applicable";
  const wpNotes: string[] = [];
  const bridgeNotes: string[] = [];
  if (!wpApplicable) {
    wpNotes.push("Not a WordPress site.");
    bridgeNotes.push("Not a WordPress site.");
  }
  if (isWordPress && platform?.seoPlugin === "yoast") {
    wpNotes.push("Yoast SEO has no API for writing its fields: without the bridge plugin only image alt text can be changed.");
  }

  // ---- which one to recommend (at most one)
  let recommended: ConnectionMethodKind | null = null;
  const why: string[] = [];
  if (behindCloudflare) {
    recommended = "CLOUDFLARE";
    why.push("Recommended: the site is behind Cloudflare, so every supported fix can be applied at the edge without installing anything on the site.");
  } else if (isWordPress && platform?.seoPlugin && WRITABLE_SEO_PLUGINS.has(platform.seoPlugin)) {
    recommended = "WORDPRESS";
    why.push(`Recommended: ${SEO_PLUGIN_LABELS[platform.seoPlugin]} can be written through its own API with a WordPress application password; nothing to install.`);
  } else if (isWordPress) {
    recommended = "WORDPRESS_BRIDGE";
    why.push("Recommended: this WordPress site's SEO fields can only be changed with the SEO Table bridge plugin (or through Cloudflare).");
  } else if (platform) {
    recommended = "FIX_PACK";
    why.push("Recommended: nothing on this site can be connected for writing; download the fix pack and apply its files by hand.");
  }

  const methods: ConnectionMethod[] = [
    {
      kind: "CLOUDFLARE",
      approach: "no_install",
      status: cfStatus,
      capabilities: config(cf).capabilities ?? null,
      notes: cfNotes,
      recommended: false,
      lastError: cf?.lastError ?? null,
      detail: cfDetail,
    },
    {
      kind: "WORDPRESS",
      approach: "no_install",
      status: wpStatus,
      capabilities: wpCaps,
      notes: wpNotes,
      recommended: false,
      lastError: wp?.lastError ?? null,
      detail: null,
    },
    {
      kind: "WORDPRESS_BRIDGE",
      approach: "plugin",
      status: bridgeStatus,
      capabilities: bridgeActive ? wpCaps : null,
      notes: bridgeNotes,
      recommended: false,
      lastError: null,
      detail: null,
    },
    {
      kind: "FIX_PACK",
      approach: "no_install",
      status: "available",
      capabilities: null,
      notes: ["Always available: every proposed fix as files (redirect rules, a meta table, a sitemap, robots.txt) to apply by hand."],
      recommended: false,
      lastError: null,
      detail: null,
    },
  ];
  for (const m of methods) {
    if (m.kind === recommended) {
      m.recommended = true;
      m.notes.unshift(...why);
    }
  }
  return {
    platform,
    writeTarget: { configured: target.configured, effective: target.kind, source: target.source },
    methods,
    notes: platform ? [] : ["The site's platform has not been detected yet, so no connection method is recommended."],
  };
}
