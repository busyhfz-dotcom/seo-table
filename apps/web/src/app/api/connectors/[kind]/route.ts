import { connectorMessage, connectorNotes } from "../../../../lib/connector-messages";
import { DEFAULT_LOCALE, isLocale } from "../../../../lib/i18n";
import { z } from "zod";
import { and, connectors, db, eq, type ConnectorKind } from "@seo/db";
import { NotFound, BadRequest, recordAudit, seal } from "@seo/core";
import { build, AWAITING_OAUTH_APP } from "@seo/connectors";
import { handler } from "../../../../lib/route";
import { defaultProject, getProject } from "../../../../lib/queries";

const KINDS = ["WORDPRESS", "SEARCH_CONSOLE", "GA4", "INSTAGRAM", "YOUTUBE"] as const;

const wordpress = z.object({
  kind: z.literal("WORDPRESS"),
  siteUrl: z.string().url(),
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

const schema = z.discriminatedUnion("kind", [wordpress, searchConsole, ga4]);

/**
 * Connect a connector.
 *
 * Credentials are verified against the real API before anything is stored, and
 * are sealed with AES-256-GCM on the way in. No response from this route, ever,
 * contains credential material.
 */
export const POST = handler({ permission: "connector:write", schema }, async ({ req, session, body, ip }) => {
  const kindParam = decodeURIComponent((await Promise.resolve(req.nextUrl.pathname)).split("/").pop() ?? "");
  const kind = kindParam.toUpperCase() as ConnectorKind;
  if (!KINDS.includes(kind as (typeof KINDS)[number])) throw new BadRequest(`Unknown connector: ${kindParam}`);
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
  const { kind: _kind, ...credentials } = body;
  const client = build(kind, credentials as never);
  const result = await client.check();

  const sealed = result.ok ? seal(JSON.stringify(credentials)) : null;
  const scopes = result.capabilities?.notes ?? [];

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
      lastSyncAt: result.ok ? new Date() : null,
      lastError: result.ok ? null : `${result.reason}: ${result.message}`,
    })
    .onConflictDoUpdate({
      target: [connectors.projectId, connectors.kind],
      set: {
        status: result.ok ? "CONNECTED" : "ERROR",
        secretCipher: sealed?.cipher ?? null,
        secretIv: sealed?.iv ?? null,
        secretTag: sealed?.tag ?? null,
        scopes,
        lastSyncAt: result.ok ? new Date() : null,
        lastError: result.ok ? null : `${result.reason}: ${result.message}`,
        updatedAt: new Date(),
      },
    });

  await recordAudit({
    orgId: session.orgId,
    actor: { type: "USER", id: session.userId, ip },
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
  };
});

/** Disconnect: the sealed credential is removed, the row stays for its history. */
export const DELETE = handler({ permission: "connector:write" }, async ({ req, session, ip }) => {
  const kind = (req.nextUrl.pathname.split("/").pop() ?? "").toUpperCase() as ConnectorKind;
  const requested = req.nextUrl.searchParams.get("projectId");
  const project = requested
    ? await getProject(session.orgId, requested)
    : await defaultProject(session.orgId);
  if (!project) throw new NotFound("No project");

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
    actor: { type: "USER", id: session.userId, ip },
    action: "connector.disconnect",
    targetType: "connector",
    targetId: `${project.id}:${kind}`,
    metadata: { kind },
  });
  return { kind, status: "NOT_CONNECTED" };
});
