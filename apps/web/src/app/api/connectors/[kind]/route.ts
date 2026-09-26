import { connectorMessage, connectorNotes, storedConnectorError } from "../../../../lib/connector-messages";
import { DEFAULT_LOCALE, isLocale } from "../../../../lib/i18n";
import { z } from "zod";
import { and, connectors, db, eq, type ConnectorKind } from "@seo/db";
import { NotFound, BadRequest, Conflict, assertPublicUrl, recordAudit, seal } from "@seo/core";
import {
  build,
  edgeForProject,
  AWAITING_OAUTH_APP,
  CONNECTOR_KINDS,
  ConnectorError,
  type CloudflareCredentials,
} from "@seo/connectors";
import { handler } from "../../../../lib/route";
import { defaultProject, getProject } from "../../../../lib/queries";

/** The connector kind from the URL, or a 400 — never a database enum error. */
function kindParam(raw: string | undefined): ConnectorKind {
  const kind = (raw ?? "").toUpperCase();
  if (!CONNECTOR_KINDS.includes(kind as ConnectorKind)) throw new BadRequest("Unknown connector", { kind: raw });
  return kind as ConnectorKind;
}

/**
 * Credentials are sent to the WordPress site, so outside development it must be
 * https. Plain http is allowed where private targets are (tests, local dev).
 */
function plainHttpAllowed(): boolean {
  return process.env.ALLOW_PRIVATE_NETWORK === "1" || process.env.NODE_ENV !== "production";
}

const wordpress = z.object({
  kind: z.literal("WORDPRESS"),
  siteUrl: z
    .string()
    .trim()
    .max(2000)
    .url()
    .refine((u) => /^https:\/\//i.test(u) || (plainHttpAllowed() && /^http:\/\//i.test(u)), {
      message: "must be an https URL",
    }),
  username: z.string().min(1),
  applicationPassword: z.string().min(8),
});

const googleCreds = z.union([
  z.object({
    type: z.literal("service_account"),
    client_email: z.string().email(),
    private_key: z.string().min(40),
    subject: z.string().email().optional(),
  }),
  z.object({
    type: z.literal("oauth_refresh"),
    client_id: z.string().min(4),
    client_secret: z.string().min(4),
    refresh_token: z.string().min(4),
  }),
]);

const searchConsole = z.object({
  kind: z.literal("SEARCH_CONSOLE"),
  siteUrl: z.string().min(4),
  google: googleCreds,
});

const ga4 = z.object({
  kind: z.literal("GA4"),
  propertyId: z.string().regex(/^\d+$/),
  google: googleCreds,
});

/**
 * A Cloudflare API token (never the Global API Key). The site it acts on is the
 * project's own address, taken from the project — never from the request.
 */
const cloudflareSchema = z.object({
  kind: z.literal("CLOUDFLARE"),
  apiToken: z
    .string()
    .trim()
    .min(20)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/, { message: "must be a Cloudflare API token" }),
});

const schema = z.discriminatedUnion("kind", [wordpress, searchConsole, ga4, cloudflareSchema]);

/**
 * Connect a connector.
 *
 * Credentials are verified against the real API before anything is stored, and
 * are sealed with AES-256-GCM on the way in. No response from this route, ever,
 * contains credential material.
 */
export const POST = handler({ permission: "connector:write", schema }, async ({ req, session, params, body, actor }) => {
  const kind = kindParam(params.kind);
  if (kind !== body.kind) throw new BadRequest("The connector in the URL and the body do not match");
  if (AWAITING_OAUTH_APP.includes(kind)) {
    throw new BadRequest(
      `${kind} has no OAuth application registered yet, so it cannot be connected. Nothing is shown for it in the meantime.`,
    );
  }

  const projectId = req.nextUrl.searchParams.get("projectId");
  const project = projectId
    ? await getProject(session.orgId, projectId)
    : await defaultProject(session.orgId);
  if (!project) throw new NotFound("No project");

  // Verify first. A connector is never stored as CONNECTED on the strength of a
  // well-formed form submission.
  const { kind: _kind, ...fields } = body;
  const credentials =
    body.kind === "CLOUDFLARE" ? ({ apiToken: body.apiToken, siteUrl: project.baseUrl } satisfies CloudflareCredentials) : fields;
  // The site URL is the one thing here that makes the server connect somewhere
  // the customer chose: refuse internal addresses before any request is made.
  if (body.kind === "WORDPRESS") await assertPublicUrl(body.siteUrl);
  const client = build(kind, credentials as never);
  const result = await client.check();

  const sealed = result.ok ? seal(JSON.stringify(credentials)) : null;
  const scopes = result.capabilities?.notes ?? [];
  // What the connection overview shows without calling the site again. No secrets.
  const config = { capabilities: result.capabilities ?? null, detail: result.detail ?? null, checkedAt: new Date().toISOString() };

  await db
    .insert(connectors)
    .values({
      projectId: project.id,
      kind,
      status: result.ok ? "CONNECTED" : "ERROR",
      secretCipher: sealed?.cipher ?? null,
      secretIv: sealed?.iv ?? null,
      secretTag: sealed?.tag ?? null,
      scopes,
      config,
      lastSyncAt: result.ok ? new Date() : null,
      lastError: result.ok ? null : storedConnectorError(result),
    })
    .onConflictDoUpdate({
      target: [connectors.projectId, connectors.kind],
      set: {
        status: result.ok ? "CONNECTED" : "ERROR",
        secretCipher: sealed?.cipher ?? null,
        secretIv: sealed?.iv ?? null,
        secretTag: sealed?.tag ?? null,
        scopes,
        config,
        lastSyncAt: result.ok ? new Date() : null,
        lastError: result.ok ? null : storedConnectorError(result),
        updatedAt: new Date(),
      },
    });

  await recordAudit({
    orgId: session.orgId,
    actor,
    action: "connector.connect",
    targetType: "connector",
    targetId: `${project.id}:${kind}`,
    // Note what was connected and whether it worked — never how.
    metadata: { kind, ok: result.ok, reason: result.reason ?? null },
  });

  const cookieLocale = req.cookies.get("locale")?.value;
  const locale = isLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE;
  return {
    kind,
    status: result.ok ? "CONNECTED" : "ERROR",
    reason: result.reason ?? null,
    message: connectorMessage(locale, result),
    capabilities: result.capabilities
      ? { ...result.capabilities, notes: connectorNotes(locale, result.capabilities.notes) }
      : null,
    // Cloudflare: {zone, hosts, installed, outdated, conflicts}, or {permission} when one is missing.
    detail: result.detail ?? null,
  };
});

/**
 * Disconnect: the sealed credential is removed, the row stays for its history.
 *
 * Cloudflare first removes the edge worker's routes and script: once the token
 * is gone the panel could never remove them, and the worker would keep
 * serving rules nobody can see here. If that fails, nothing is disconnected —
 * unless `?keepEdge=1` says to leave the worker running on purpose.
 */
export const DELETE = handler({ permission: "connector:write" }, async ({ req, session, params, actor }) => {
  const kind = kindParam(params.kind);
  const requested = req.nextUrl.searchParams.get("projectId");
  const project = requested
    ? await getProject(session.orgId, requested)
    : await defaultProject(session.orgId);
  if (!project) throw new NotFound("No project");

  if (kind === "CLOUDFLARE" && req.nextUrl.searchParams.get("keepEdge") !== "1") {
    const row = (await db.select().from(connectors).where(and(eq(connectors.projectId, project.id), eq(connectors.kind, kind))).limit(1))[0];
    if (row?.status === "CONNECTED") {
      try {
        const removed = await (await edgeForProject(project.id)).uninstall();
        await recordAudit({
          orgId: session.orgId,
          actor,
          action: "connector.uninstall_edge",
          targetType: "connector",
          targetId: `${project.id}:${kind}`,
          metadata: { ok: true, routes: removed.removedRoutes, scriptDeleted: removed.scriptDeleted, via: "disconnect" },
        });
      } catch (err) {
        const reason = err instanceof ConnectorError ? err.code : "network_error";
        throw new Conflict("The edge worker could not be removed from Cloudflare, so the connection was kept.", { reason });
      }
    }
  }

  await db
    .update(connectors)
    .set({
      status: "NOT_CONNECTED",
      secretCipher: null,
      secretIv: null,
      secretTag: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(connectors.projectId, project.id), eq(connectors.kind, kind)));

  await recordAudit({
    orgId: session.orgId,
    actor,
    action: "connector.disconnect",
    targetType: "connector",
    targetId: `${project.id}:${kind}`,
    metadata: { kind },
  });
  return { kind, status: "NOT_CONNECTED" };
});
