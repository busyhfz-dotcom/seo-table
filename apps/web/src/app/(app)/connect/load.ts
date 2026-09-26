/**
 * Everything the connect screens show, read on the server from stored state
 * (no third-party call) and already in the reader's language, as plain data a
 * client component can take.
 */
import { buildFixPack, connectionOverview } from "@seo/connectors";
import type { PlatformInfo, Project } from "@seo/db";
import type { Locale } from "../../../lib/i18n";
import { connectorMessage, connectorNotes } from "../../../lib/connector-messages";
import { latestRunFor, listConnectors } from "../../../lib/queries";
import { relative } from "../../../lib/format";

export type MethodKind = "CLOUDFLARE" | "WORDPRESS" | "WORDPRESS_BRIDGE" | "FIX_PACK";
export type MethodStatus =
  | "connected"
  | "needs_install"
  | "not_installed"
  | "not_connected"
  | "error"
  | "not_applicable"
  | "available";

export type MethodView = {
  kind: MethodKind;
  approach: "no_install" | "plugin";
  status: MethodStatus;
  recommended: boolean;
  notes: string[];
  capabilities: { writableFields: string[]; supportedActions: string[]; notes: string[] } | null;
  lastError: string | null;
  detail: Record<string, unknown> | null;
};

export type FixPackView = {
  counts: Record<string, number>;
  files: Array<{ path: string; bytes: number }>;
};

export type ConnectionView = {
  projectId: string;
  projectName: string;
  baseUrl: string;
  host: string;
  platform: PlatformInfo | null;
  /** When it was detected, worded on the server (a client clock would disagree with it). */
  detectedLabel: string | null;
  writeTarget: { configured: "WORDPRESS" | "CLOUDFLARE" | null; effective: "WORDPRESS" | "CLOUDFLARE"; source: string };
  notes: string[];
  methods: MethodView[];
  fixPack: FixPackView | null;
  searchConsole: { status: string; lastError: string | null };
  hasRun: boolean;
};

/** "<reason>: <English sentence>" as stored for the logs, in the reader's language. */
export function storedErrorText(locale: Locale, stored: string | null | undefined): string | null {
  if (!stored) return null;
  const [reason, ...rest] = stored.split(": ");
  return connectorMessage(locale, { ok: false, reason, message: rest.join(": ") }) || null;
}

export async function loadConnection(project: Project, locale: Locale): Promise<ConnectionView> {
  const [overview, connectors, run, pack] = await Promise.all([
    connectionOverview(project.id),
    listConnectors(project.id),
    latestRunFor(project.id),
    // The pack is built from stored proposals; a failure only hides the listing.
    buildFixPack(project.id).catch(() => null),
  ]);
  const gsc = connectors.find((c) => c.kind === "SEARCH_CONSOLE");
  return {
    projectId: project.id,
    projectName: project.name,
    baseUrl: project.baseUrl,
    host: new URL(project.baseUrl).host,
    platform: overview.platform,
    detectedLabel: overview.platform ? relative(overview.platform.detectedAt, locale) : null,
    writeTarget: overview.writeTarget,
    notes: connectorNotes(locale, overview.notes),
    methods: overview.methods.map((m) => ({
      kind: m.kind,
      approach: m.approach,
      status: m.status,
      recommended: m.recommended,
      notes: connectorNotes(locale, m.notes),
      capabilities: m.capabilities
        ? {
            writableFields: m.capabilities.writableFields,
            supportedActions: m.capabilities.supportedActions,
            notes: connectorNotes(locale, m.capabilities.notes),
          }
        : null,
      lastError: storedErrorText(locale, m.lastError),
      detail: m.detail,
    })),
    fixPack: pack
      ? { counts: pack.counts, files: pack.files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.body) })) }
      : null,
    searchConsole: { status: gsc?.status ?? "NOT_CONNECTED", lastError: storedErrorText(locale, gsc?.lastError) },
    hasRun: Boolean(run),
  };
}
