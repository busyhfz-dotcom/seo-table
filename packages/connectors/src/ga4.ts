/**
 * GA4 connector — Analytics Data API v1beta, read-only.
 *
 * Used to tell the difference between a page that ranks and a page that earns:
 * sessions and key events per landing page, joined to snapshots by URL path.
 */
import { accessToken, SCOPES, type GoogleCredentials } from "./google-auth.js";
import {
  ConnectorError,
  httpJson,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorHealth,
} from "./types.js";

const API = "https://analyticsdata.googleapis.com/v1beta";

export type Ga4Credentials = {
  /** Numeric GA4 property id, without the "properties/" prefix. */
  propertyId: string;
  google: GoogleCredentials;
};

export type PageMetrics = {
  /** Landing page path without the query string, so it joins to snapshots by path. */
  path: string;
  sessions: number;
  users: number;
  engagedSessions: number;
  /** GA4 renamed "conversions" to key events; the old metric is deprecated. */
  keyEvents: number;
  /** averageSessionDuration: mean session length in seconds (not engagement time). */
  averageSessionDurationSeconds: number;
};

export function ga4(creds: Ga4Credentials): Connector & {
  pageMetrics: (range: { start: Date; end: Date }, limit?: number) => Promise<PageMetrics[]>;
} {
  async function headers(): Promise<Record<string, string>> {
    const token = await accessToken(creds.google, [...SCOPES.analytics]);
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  async function capabilities(): Promise<ConnectorCapabilities> {
    return {
      writableFields: [],
      supportedActions: [],
      notes: ["Read-only. Supplies sessions, engagement and key events per landing page."],
    };
  }

  async function check(): Promise<ConnectorHealth & { capabilities?: ConnectorCapabilities }> {
    try {
      const res = await httpJson<{ dimensions?: unknown[]; error?: { message?: string } }>(
        `${API}/properties/${creds.propertyId}/metadata`,
        { headers: await headers() },
      );
      if (res.status === 403) {
        return {
          ok: false,
          reason: "no_property_access",
          message: `The credential cannot read property ${creds.propertyId}. Grant it Viewer on the property.`,
        };
      }
      if (res.status === 404) {
        return { ok: false, reason: "property_not_found", message: `Property ${creds.propertyId} does not exist.` };
      }
      if (res.status >= 400) {
        return { ok: false, reason: `http_${res.status}`, message: res.data?.error?.message ?? res.text.slice(0, 200) };
      }
      return { ok: true, message: `Connected to GA4 property ${creds.propertyId}.`, capabilities: await capabilities() };
    } catch (err) {
      if (err instanceof ConnectorError) return { ok: false, reason: err.code, message: err.message };
      return { ok: false, reason: "network_error", message: (err as Error).message };
    }
  }

  async function pageMetrics(range: { start: Date; end: Date }, limit = 5000): Promise<PageMetrics[]> {
    const res = await httpJson<{
      rows?: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }>;
      error?: { message?: string };
    }>(`${API}/properties/${creds.propertyId}:runReport`, {
      method: "POST",
      headers: await headers(),
      body: JSON.stringify({
        dateRanges: [{ startDate: iso(range.start), endDate: iso(range.end) }],
        dimensions: [{ name: "landingPage" }],
        metrics: [
          { name: "sessions" },
          { name: "totalUsers" },
          { name: "engagedSessions" },
          { name: "keyEvents" },
          { name: "averageSessionDuration" },
        ],
        limit,
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      }),
      timeoutMs: 40_000,
    });

    if (res.status >= 400) {
      throw new ConnectorError(`http_${res.status}`, res.data?.error?.message ?? res.text.slice(0, 200));
    }

    return (res.data?.rows ?? []).map((row) => ({
      path: row.dimensionValues?.[0]?.value ?? "",
      sessions: num(row.metricValues?.[0]?.value),
      users: num(row.metricValues?.[1]?.value),
      engagedSessions: num(row.metricValues?.[2]?.value),
      keyEvents: num(row.metricValues?.[3]?.value),
      averageSessionDurationSeconds: num(row.metricValues?.[4]?.value),
    }));
  }

  return { kind: "GA4", check, capabilities, pageMetrics };
}

function num(v: string | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
