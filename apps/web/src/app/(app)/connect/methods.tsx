"use client";

/**
 * The connection methods, each as a card: what it is, its status, what it can
 * change on this site, and the guided form or controls to connect it. Used by
 * the connect screen and by onboarding.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Icon } from "../../../components/icons";
import { Fill, UserText } from "../../../components/ui";
import { apiErrorMessage, callApi } from "../../../lib/errors-ui";
import { num } from "../../../lib/format";
import { fill } from "../../../lib/i18n";
import type { PlatformInfo } from "@seo/db";
import type { ConnectionView, FixPackView, MethodKind, MethodView } from "./load";
import {
  Consent,
  ConfirmButton,
  FieldList,
  Message,
  MethodStatusPill,
  Spinner,
  digits,
  useConnect,
  useRefresh,
  useSize,
  type Msg,
} from "./parts";

/** What each method can write once connected, before anything has been probed. */
const POTENTIAL: Record<Exclude<MethodKind, "FIX_PACK">, string[]> = {
  CLOUDFLARE: ["title", "meta_description", "canonical", "meta_robots", "img.alt", "jsonld", "hreflang", "redirect"],
  WORDPRESS: ["title", "meta_description", "canonical", "meta_robots", "img.alt"],
  WORDPRESS_BRIDGE: ["title", "meta_description", "canonical", "meta_robots", "img.alt", "redirect"],
};

const SEO_PLUGIN_NAMES: Record<string, string> = {
  rankmath: "Rank Math",
  seopress: "SEOPress",
  aioseo: "All in One SEO",
  yoast: "Yoast SEO",
};

const CMS_NAMES: Record<string, string> = {
  shopify: "Shopify",
  wix: "Wix",
  squarespace: "Squarespace",
  webflow: "Webflow",
  joomla: "Joomla",
  drupal: "Drupal",
  magento: "Magento",
  nextjs: "Next.js",
  nuxt: "Nuxt",
};

const CDN_NAMES: Record<string, string> = {
  cloudflare: "Cloudflare",
  fastly: "Fastly",
  cloudfront: "CloudFront",
  akamai: "Akamai",
  vercel: "Vercel",
  netlify: "Netlify",
  bunnycdn: "BunnyCDN",
  sucuri: "Sucuri",
};

export function methodIcon(kind: MethodKind): string {
  return kind === "CLOUDFLARE" ? "cloud" : kind === "WORDPRESS" ? "globe" : kind === "WORDPRESS_BRIDGE" ? "puzzle" : "box";
}

// ------------------------------------------------------------------ platform

export function PlatformCard({
  platform,
  detectedLabel,
  compact,
}: {
  platform: PlatformInfo | null;
  detectedLabel: string | null;
  compact?: boolean;
}) {
  const { s, locale, projectId, canRun } = useConnect();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [refreshing, refresh] = useRefresh();

  const detect = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    const res = await callApi<{ ok: boolean; message?: string }>(`/api/projects/${projectId}/platform`, { method: "POST" });
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "crit", text: apiErrorMessage(locale, res.failure) });
    if (!res.data.ok) return setMsg({ tone: "crit", text: res.data.message ?? "" });
    setMsg({ tone: "ok", text: s.cn_detected_ok });
    refresh();
  }, [projectId, locale, refresh, s.cn_detected_ok]);

  // A new site arrives here undetected (detection runs in the background after
  // it is added): ask once instead of showing an empty card.
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!platform && canRun && !asked) {
      setAsked(true);
      void detect();
    }
  }, [platform, canRun, asked, detect]);

  const cms = platform
    ? platform.cms === "wordpress"
      ? s.cn_cms_wordpress
      : platform.cms === "custom"
        ? s.cn_cms_custom
        : (CMS_NAMES[platform.cms] ?? platform.cms)
    : null;
  const cdn = platform?.cdn ? (platform.cdn === "arvancloud" ? s.cn_cdn_arvancloud : (CDN_NAMES[platform.cdn] ?? platform.cdn)) : null;
  const working = busy || refreshing;

  return (
    <section className="card stack">
      <header>
        <h3>{compact ? s.ob_detect_title : s.cn_platform}</h3>
        <span className="spacer" />
        {canRun && (
          <button className="btn ghost sm" onClick={detect} disabled={working}>
            {working ? <Spinner /> : <Icon name="refresh" />}
            {platform ? s.cn_detect : s.cn_detect_first}
          </button>
        )}
      </header>
      <div className="body">
        {working && !platform ? (
          <p className="muted" role="status">
            <Spinner /> {s.cn_detecting}
          </p>
        ) : !platform ? (
          <p className="muted">{s.cn_not_detected}</p>
        ) : (
          <dl className="platform">
            <div>
              <dt>{s.cn_cms}</dt>
              <dd>
                {cms}
                {platform.cmsVersion && (
                  <span className="muted"> · {fill(s.cn_version, { v: digits(platform.cmsVersion, locale) })}</span>
                )}
              </dd>
            </div>
            <div>
              <dt>{s.cn_seo_plugin}</dt>
              <dd>{platform.seoPlugin ? SEO_PLUGIN_NAMES[platform.seoPlugin] : <span className="muted">{s.cn_none_found}</span>}</dd>
            </div>
            <div>
              <dt>{s.cn_cdn}</dt>
              <dd>{cdn ?? <span className="muted">{s.cn_none_found}</span>}</dd>
            </div>
            <div>
              <dt>{s.cn_server}</dt>
              <dd>{platform.server ? <UserText>{platform.server}</UserText> : <span className="muted">—</span>}</dd>
            </div>
            <div>
              <dt>{s.cn_detected_at}</dt>
              <dd>{detectedLabel ?? "—"}</dd>
            </div>
          </dl>
        )}
        <Message msg={msg} />
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ card shell

export function MethodCard({
  method,
  children,
  potential,
}: {
  method: MethodView;
  children?: ReactNode;
  /** Fields it could write once connected, shown while nothing has been probed. */
  potential?: string[];
}) {
  const { s } = useConnect();
  const caps = method.capabilities;
  const showCaps = caps && caps.writableFields.length > 0;
  return (
    <section className={`card method${method.recommended ? " recommended" : ""}`} id={`method-${method.kind}`}>
      <header>
        <span className="mico" aria-hidden="true">
          <Icon name={methodIcon(method.kind)} />
        </span>
        <h3>{s[`m_${method.kind}`]}</h3>
        {method.recommended && (
          <span className="pill acc">
            <Icon name="check" />
            {s.cn_recommended}
          </span>
        )}
        <span className="spacer" />
        <MethodStatusPill status={method.status} />
      </header>
      <div className="body">
        <p className="desc">{s[`md_${method.kind}`]}</p>

        {method.lastError && method.status === "error" && <Message msg={{ tone: "crit", text: method.lastError }} />}

        {method.notes.length > 0 && (
          <ul className="plain notes">
            {method.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}

        {showCaps ? (
          <div className="caps">
            <div className="caps-h">{s.cn_can_change}</div>
            <FieldList fields={caps.writableFields} />
          </div>
        ) : potential && method.status !== "not_applicable" ? (
          <div className="caps">
            <div className="caps-h">{method.status === "connected" ? s.cn_can_change : s.cn_would_change}</div>
            {method.status === "connected" ? <p className="muted">{s.cn_nothing_writable}</p> : <FieldList fields={potential} />}
          </div>
        ) : null}

        {caps && caps.notes.length > 0 && (
          <ul className="plain notes">
            {caps.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}

        {children}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ Cloudflare

type EdgeStatus =
  | {
      ok: true;
      zone: string;
      hosts: string[];
      scriptName: string;
      installed: boolean;
      outdated: boolean;
      routes: string[];
      conflicts: Array<{ pattern: string; script: string | null }>;
      shadowed: string[];
    }
  | { ok: false; reason: string; message: string };

const CF_PERMISSIONS: Array<{ name: string; why: "cf_perm_zone" | "cf_perm_dns" | "cf_perm_routes" | "cf_perm_scripts" | "cf_perm_kv" }> = [
  { name: "Zone → Zone → Read", why: "cf_perm_zone" },
  { name: "Zone → DNS → Read", why: "cf_perm_dns" },
  { name: "Zone → Workers Routes → Edit", why: "cf_perm_routes" },
  { name: "Account → Workers Scripts → Edit", why: "cf_perm_scripts" },
  { name: "Account → Workers KV Storage → Edit", why: "cf_perm_kv" },
];

const CF_TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

export function CloudflareMethod({ method }: { method: MethodView }) {
  const { s, locale, projectId, canWrite } = useConnect();
  const [refreshing, refresh] = useRefresh();
  const connected = method.status === "connected" || method.status === "needs_install";
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const detail = method.detail as { zone?: string; hosts?: string[] } | null;

  async function check() {
    setBusy(true);
    setMsg(null);
    const res = await callApi<{ status: string; message: string }>(`/api/projects/${projectId}/connection/check`, {
      method: "POST",
      body: { kind: "CLOUDFLARE" },
    });
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "crit", text: apiErrorMessage(locale, res.failure) });
    setMsg(res.data.status === "CONNECTED" ? { tone: "ok", text: s.cn_checked_ok } : { tone: "crit", text: res.data.message });
    refresh();
  }

  async function disconnect() {
    setBusy(true);
    setMsg(null);
    const res = await callApi(`/api/connectors/CLOUDFLARE?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "crit", text: apiErrorMessage(locale, res.failure) });
    setMsg({ tone: "ok", text: s.cn_disconnected });
    refresh();
  }

  return (
    <MethodCard method={method} potential={POTENTIAL.CLOUDFLARE}>
      {connected && detail?.zone && (
        <dl className="kv compact">
          <dt>{s.cf_zone}</dt>
          <dd>
            <UserText>{detail.zone}</UserText>
          </dd>
          {detail.hosts && detail.hosts.length > 0 && (
            <>
              <dt>{s.cf_hosts}</dt>
              <dd>
                <UserText>{detail.hosts.join(locale === "fa" ? "، " : ", ")}</UserText>
              </dd>
            </>
          )}
        </dl>
      )}

      {connected && <EdgePanel onChanged={refresh} />}

      {(!connected || editing) && canWrite && (
        <CloudflareForm
          onConnected={() => {
            setEditing(false);
            refresh();
          }}
        />
      )}

      {method.status !== "not_connected" && canWrite && (
        <div className="row">
          <button className="btn ghost" onClick={check} disabled={busy || refreshing}>
            {busy ? <Spinner /> : <Icon name="refresh" />}
            {s.cn_check}
          </button>
          {connected && !editing && (
            <button className="btn ghost" onClick={() => setEditing(true)}>
              <Icon name="key" />
              {s.cn_reconnect}
            </button>
          )}
          <ConfirmButton label={s.cf_disconnect} question={s.cf_disconnect_confirm} onConfirm={disconnect} disabled={busy} />
        </div>
      )}
      {!canWrite && <p className="muted">{s.cn_no_permission}</p>}
      <Message msg={msg} />
    </MethodCard>
  );
}

function CloudflareForm({ onConnected }: { onConnected: () => void }) {
  const { s, locale, projectId } = useConnect();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!consent) return setMsg({ tone: "crit", text: s.cn_consent_needed });
    const token = String(new FormData(event.currentTarget).get("apiToken") ?? "").trim();
    setBusy(true);
    setMsg(null);
    const res = await callApi<{ status: string; message: string; detail?: { permission?: string } | null }>(
      `/api/connectors/CLOUDFLARE?projectId=${encodeURIComponent(projectId)}`,
      { method: "POST", body: { kind: "CLOUDFLARE", apiToken: token } },
    );
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "crit", text: apiErrorMessage(locale, res.failure) });
    if (res.data.status === "CONNECTED") {
      setMsg({ tone: "ok", text: res.data.message });
      onConnected();
      return;
    }
    setMsg({ tone: "crit", text: res.data.message });
  }

  return (
    <form className="guided" onSubmit={submit}>
      <div className="howto">
        <p>
          <Fill
            template={s.cf_token_help}
            slots={{
              path: <code dir="ltr">My Profile → API Tokens → Create Token</code>,
              custom: <code dir="ltr">Custom token</code>,
            }}
          />
        </p>
        <ul className="checklist">
          {CF_PERMISSIONS.map((p) => (
            <li key={p.name}>
              <Icon name="check" />
              <code dir="ltr">{p.name}</code>
              <span className="why">{s[p.why]}</span>
            </li>
          ))}
        </ul>
        <p className="muted">
          <Fill
            template={s.cf_token_scope}
            slots={{ resources: <code dir="ltr">Zone Resources</code>, global: <code dir="ltr">Global API Key</code> }}
          />
        </p>
        <p className="muted">
          <Icon name="cloud" /> {s.cf_proxied_note}
        </p>
        <a className="btn ghost sm" href={CF_TOKENS_URL} target="_blank" rel="noreferrer noopener">
          <Icon name="external" />
          {s.cf_open_dashboard}
        </a>
      </div>
      <label className="field">
        <span>{s.cf_token}</span>
        <input
          name="apiToken"
          type="password"
          required
          minLength={20}
          maxLength={200}
          pattern="[A-Za-z0-9_\-]+"
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <p className="muted small">{s.cn_secret_note}</p>
      <Consent checked={consent} onChange={setConsent} />
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy || !consent}>
          {busy ? <Spinner /> : <Icon name="link" />}
          {s.cn_verify_connect}
        </button>
      </div>
      <Message msg={msg} />
    </form>
  );
}

function EdgePanel({ onChanged }: { onChanged: () => void }) {
  const { s, locale, projectId, canWrite } = useConnect();
  const [edge, setEdge] = useState<EdgeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const res = await callApi<EdgeStatus>(`/api/projects/${projectId}/connection/edge`);
    if (!res.ok) return setError(apiErrorMessage(locale, res.failure));
    setEdge(res.data);
  }, [projectId, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(method: "POST" | "DELETE") {
    setBusy(true);
    setMsg(null);
    const res = await callApi<{ ok: boolean; message?: string; notes?: string[] }>(`/api/projects/${projectId}/connection/edge`, {
      method,
    });
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "crit", text: apiErrorMessage(locale, res.failure) });
    if (!res.data.ok) return setMsg({ tone: "crit", text: res.data.message ?? "" });
    setMsg({ tone: "ok", text: method === "POST" ? s.cf_installed_ok : s.cf_removed_ok });
    setConsent(false);
    await load();
    onChanged();
  }

  if (error) return <Message msg={{ tone: "crit", text: error }} />;
  if (!edge) {
    return (
      <p className="muted" role="status">
        <Spinner /> {s.cf_edge_loading}
      </p>
    );
  }
  if (!edge.ok) return <Message msg={{ tone: "crit", text: edge.message }} />;

  const state = edge.installed ? (edge.outdated ? "outdated" : "installed") : "not_installed";
  const blocked = edge.conflicts.length > 0;
  const needsChange = !edge.installed || edge.outdated;

  return (
    <div className="edge">
      <div className="edge-h">
        <b>{s.cf_edge}</b>
        <span className={`pill ${state === "installed" ? "ok" : "warn"}`}>
          <Icon name={state === "installed" ? "check" : "alert"} />
          {state === "installed" ? s.cf_edge_installed : state === "outdated" ? s.cf_edge_outdated : s.cf_edge_not_installed}
        </span>
      </div>

      {edge.routes.length > 0 && (
        <div>
          <div className="caps-h">{s.cf_routes}</div>
          <ul className="codes">
            {edge.routes.map((r) => (
              <li key={r}>
                <code dir="ltr">{r}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      {blocked && (
        <div className="note crit">
          <Icon name="alert" />
          <div>
            {s.cf_conflicts}
            <ul className="codes">
              {edge.conflicts.map((c) => (
                <li key={c.pattern}>
                  <code dir="ltr">
                    {c.pattern}
                    {c.script ? ` → ${c.script}` : ""}
                  </code>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {edge.shadowed.length > 0 && (
        <div className="note">
          <Icon name="info" />
          <div>
            {s.cf_shadowed}
            <ul className="codes">
              {edge.shadowed.map((p) => (
                <li key={p}>
                  <code dir="ltr">{p}</code>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {canWrite && needsChange && !blocked && (
        <div className="guided">
          <p>
            <Fill template={s.cf_install_what} slots={{ script: <code dir="ltr">{edge.scriptName}</code> }} />
          </p>
          <ul className="codes">
            {edge.hosts.map((h) => (
              <li key={h}>
                <code dir="ltr">{`${h}/*`}</code>
              </li>
            ))}
          </ul>
          <Consent checked={consent} onChange={setConsent} />
          <div className="row">
            <button className="btn primary" onClick={() => act("POST")} disabled={busy || !consent}>
              {busy ? <Spinner /> : <Icon name={edge.installed ? "refresh" : "dl"} />}
              {edge.installed ? s.cf_update : s.cf_install}
            </button>
          </div>
        </div>
      )}

      {canWrite && edge.installed && (
        <div className="row">
          <ConfirmButton label={s.cf_uninstall} question={s.cf_uninstall_confirm} onConfirm={() => act("DELETE")} disabled={busy} />
        </div>
      )}
      <Message msg={msg} />
    </div>
  );
}

// ------------------------------------------------------------------ WordPress

export function WordPressMethod({ method, platform }: { method: MethodView; platform: PlatformInfo | null }) {
  const { s, locale, projectId, canWrite } = useConnect();
  const [refreshing, refresh] = useRefresh();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const connected = method.status === "connected";
  const applicable = method.status !== "not_applicable";

  async function check() {
    setBusy(true);
    setMsg(null);
    const res = await callApi<{ status: string; message: string }>(`/api/projects/${projectId}/connection/check`, {
      method: "POST",
      body: { kind: "WORDPRESS" },
    });
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "crit", text: apiErrorMessage(locale, res.failure) });
    setMsg(res.data.status === "CONNECTED" ? { tone: "ok", text: s.cn_checked_ok } : { tone: "crit", text: res.data.message });
    refresh();
  }

  async function disconnect() {
    setBusy(true);
    setMsg(null);
    const res = await callApi(`/api/connectors/WORDPRESS?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "crit", text: apiErrorMessage(locale, res.failure) });
    setMsg({ tone: "ok", text: s.cn_disconnected });
    refresh();
  }

  const plugin = platform?.seoPlugin ? SEO_PLUGIN_NAMES[platform.seoPlugin] : null;
  const writablePlugin = platform?.seoPlugin && platform.seoPlugin !== "yoast";

  return (
    <MethodCard method={method} potential={writablePlugin || !platform ? POTENTIAL.WORDPRESS : ["img.alt"]}>
      {plugin && applicable && <p className="muted">{fill(s.wp_detected_plugin, { plugin })}</p>}
      {applicable && (!connected || editing) && canWrite && (
        <WordPressForm
          onConnected={() => {
            setEditing(false);
            refresh();
          }}
        />
      )}
      {method.status !== "not_connected" && applicable && canWrite && (
        <div className="row">
          <button className="btn ghost" onClick={check} disabled={busy || refreshing}>
            {busy ? <Spinner /> : <Icon name="refresh" />}
            {s.cn_check}
          </button>
          {connected && !editing && (
            <button className="btn ghost" onClick={() => setEditing(true)}>
              <Icon name="key" />
              {s.cn_reconnect}
            </button>
          )}
          <ConfirmButton label={s.wp_disconnect} question={s.wp_disconnect_confirm} onConfirm={disconnect} disabled={busy} />
        </div>
      )}
      {/* Detection reads the home page; a WordPress site that hides it can still be connected. */}
      {!applicable && canWrite && (
        <details className="howto">
          <summary>{s.wp_force}</summary>
          <WordPressForm onConnected={refresh} />
        </details>
      )}
      {!canWrite && applicable && <p className="muted">{s.cn_no_permission}</p>}
      <Message msg={msg} />
    </MethodCard>
  );
}

/** Also the bridge plugin's connection: the plugin is reached through the same WordPress login. */
export function WordPressForm({ onConnected }: { onConnected: () => void }) {
  const { s, locale, projectId, baseUrl } = useConnect();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!consent) return setMsg({ tone: "crit", text: s.cn_consent_needed });
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setMsg(null);
    const res = await callApi<{ status?: string; message?: string; capabilities?: { notes?: string[] } | null }>(
      `/api/connectors/wordpress?projectId=${encodeURIComponent(projectId)}`,
      {
        method: "POST",
        body: {
          kind: "WORDPRESS",
          siteUrl: String(form.get("siteUrl") ?? ""),
          username: String(form.get("username") ?? ""),
          applicationPassword: String(form.get("applicationPassword") ?? ""),
        },
      },
    );
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "crit", text: apiErrorMessage(locale, res.failure) });
    const ok = res.data.status === "CONNECTED";
    setMsg({ tone: ok ? "ok" : "crit", text: res.data.message ?? "", list: res.data.capabilities?.notes ?? [] });
    if (ok) onConnected();
  }

  return (
    <form className="guided" onSubmit={submit}>
      <details className="howto">
        <summary>{s.wp_howto_title}</summary>
        <ol>
          <li>{s.wp_howto_1}</li>
          <li>{s.wp_howto_2}</li>
          <li>{s.wp_howto_3}</li>
          <li>{s.wp_howto_4}</li>
        </ol>
      </details>
      <div className="grid g3 tight">
        <label className="field">
          <span>{s.site_url}</span>
          <input name="siteUrl" type="url" required dir="ltr" defaultValue={baseUrl} />
        </label>
        <label className="field">
          <span>{s.username}</span>
          <input name="username" required dir="ltr" autoComplete="off" spellCheck={false} />
        </label>
        <label className="field">
          <span>{s.app_password}</span>
          <input
            name="applicationPassword"
            type="password"
            required
            minLength={8}
            dir="ltr"
            autoComplete="off"
            placeholder="•••• •••• •••• •••• •••• ••••"
          />
        </label>
      </div>
      <p className="muted small">{s.cn_secret_note}</p>
      <Consent checked={consent} onChange={setConsent} />
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy || !consent}>
          {busy ? <Spinner /> : <Icon name="link" />}
          {s.cn_verify_connect}
        </button>
      </div>
      <Message msg={msg} />
    </form>
  );
}

// ------------------------------------------------------------------ bridge plugin

export function BridgeMethod({ method, wordpress }: { method: MethodView; wordpress: MethodView | undefined }) {
  const { s, locale, projectId, canWrite } = useConnect();
  const [refreshing, refresh] = useRefresh();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const wpConnected = wordpress?.status === "connected";

  async function check() {
    setBusy(true);
    setMsg(null);
    const res = await callApi<{ status: string; message: string; capabilities?: { writableFields?: string[] } | null }>(
      `/api/projects/${projectId}/connection/check`,
      { method: "POST", body: { kind: "WORDPRESS" } },
    );
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "crit", text: apiErrorMessage(locale, res.failure) });
    if (res.data.status !== "CONNECTED") return setMsg({ tone: "crit", text: res.data.message });
    const active = res.data.capabilities?.writableFields?.includes("redirect");
    setMsg(active ? { tone: "ok", text: s.bp_active } : { tone: "info", text: s.ms_not_installed });
    refresh();
  }

  if (method.status === "not_applicable") return <MethodCard method={method} />;

  return (
    <MethodCard method={method} potential={POTENTIAL.WORDPRESS_BRIDGE}>
      {method.status === "connected" ? (
        <p className="ok-line">
          <Icon name="check" /> {s.bp_active}
        </p>
      ) : (
        <ol className="steps-list">
          <li>
            <span>{s.bp_step1}</span>
            <a className="btn ghost sm" href={`/api/projects/${projectId}/connection/bridge-plugin`} download>
              <Icon name="dl" />
              {s.bp_download} · {fill(s.bp_version, { v: digits("0.5.0", locale) })}
            </a>
          </li>
          <li>{s.bp_step2}</li>
          <li>
            <span>{s.bp_step3}</span>
            {!wpConnected && (
              <a className="btn ghost sm" href="#method-WORDPRESS">
                <Icon name="link" />
                {s.cn_goto_wp}
              </a>
            )}
          </li>
          <li>{s.bp_step4}</li>
        </ol>
      )}
      <p className="muted small">{s.bp_mu}</p>
      {canWrite && (
        <div className="row">
          <button className="btn ghost" onClick={check} disabled={busy || refreshing || !wpConnected}>
            {busy ? <Spinner /> : <Icon name="refresh" />}
            {s.cn_check}
          </button>
          {!wpConnected && <span className="muted small">{s.bp_needs_wp}</span>}
        </div>
      )}
      <Message msg={msg} />
    </MethodCard>
  );
}

// ------------------------------------------------------------------ fix pack

const COUNT_KEYS = {
  redirects: "fp_c_redirects",
  meta: "fp_c_meta",
  images: "fp_c_images",
  jsonld: "fp_c_jsonld",
  sitemap: "fp_c_sitemap",
  robots: "fp_c_robots",
} as const;

export function FixPackMethod({ method, pack }: { method: MethodView; pack: FixPackView | null }) {
  const { s, locale, projectId } = useConnect();
  const size = useSize();
  const counts = Object.entries(pack?.counts ?? {}).filter(([k, n]) => n > 0 && k in COUNT_KEYS);
  return (
    <MethodCard method={method}>
      {counts.length === 0 ? (
        <p className="muted">{s.fp_empty}</p>
      ) : (
        <>
          <ul className="chips">
            {counts.map(([k, n]) => (
              <li key={k}>{fill(s[COUNT_KEYS[k as keyof typeof COUNT_KEYS]], { n: num(n, locale) })}</li>
            ))}
          </ul>
          <details className="files">
            <summary>
              {s.fp_files} ({num(pack?.files.length ?? 0, locale)})
            </summary>
            <ul>
              {pack?.files.map((f) => (
                <li key={f.path}>
                  <code dir="ltr">{f.path}</code>
                  <span className="muted">{size(f.bytes)}</span>
                </li>
              ))}
            </ul>
          </details>
          <div className="row">
            <a className="btn primary" href={`/api/projects/${projectId}/fix-pack`} download>
              <Icon name="dl" />
              {s.fp_download}
            </a>
          </div>
        </>
      )}
    </MethodCard>
  );
}

// ------------------------------------------------------------------ write target

export function WriteTargetCard({ view }: { view: ConnectionView }) {
  const { s, locale, projectId, canWrite } = useConnect();
  const [refreshing, refresh] = useRefresh();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const status = (k: MethodKind) => view.methods.find((m) => m.kind === k)?.status;
  const cfConnected = status("CLOUDFLARE") === "connected" || status("CLOUDFLARE") === "needs_install";
  const wpConnected = status("WORDPRESS") === "connected";
  const saved = view.writeTarget.configured ?? "AUTO";
  // Shown chosen at once; put back if the server refuses.
  const [current, setCurrent] = useState<"AUTO" | "CLOUDFLARE" | "WORDPRESS">(saved);
  useEffect(() => setCurrent(saved), [saved]);

  async function choose(value: "AUTO" | "CLOUDFLARE" | "WORDPRESS") {
    setCurrent(value);
    setBusy(true);
    setMsg(null);
    const res = await callApi(`/api/projects/${projectId}/connection`, {
      method: "PATCH",
      body: { writeTarget: value === "AUTO" ? null : value },
    });
    setBusy(false);
    if (!res.ok) {
      setCurrent(saved);
      const kind = value === "AUTO" ? undefined : value;
      return setMsg({
        tone: "crit",
        text: apiErrorMessage(locale, {
          ...res.failure,
          ...(res.failure.code === "CONFLICT" ? { code: "CONNECTOR_NOT_CONNECTED", details: { kind } } : {}),
        }),
      });
    }
    setMsg({ tone: "ok", text: s.wt_saved });
    refresh();
  }

  const options: Array<{ value: "AUTO" | "CLOUDFLARE" | "WORDPRESS"; label: string; help: string; enabled: boolean }> = [
    { value: "AUTO", label: s.wt_auto, help: s.wt_auto_help, enabled: true },
    { value: "CLOUDFLARE", label: s.tg_CLOUDFLARE, help: s.wt_cf_help, enabled: cfConnected },
    { value: "WORDPRESS", label: s.tg_WORDPRESS, help: s.wt_wp_help, enabled: wpConnected },
  ];
  const source = s[`wt_src_${view.writeTarget.source}` as "wt_src_default"] ?? view.writeTarget.source;

  return (
    <section className="card stack">
      <header>
        <h3>{s.wt_title}</h3>
        <span className="sub">
          {(view.writeTarget.effective === "CLOUDFLARE" ? status("CLOUDFLARE") === "connected" : wpConnected)
            ? `${fill(s.wt_now, { target: s[`tg_${view.writeTarget.effective}`] })} · ${source}`
            : s.fx_no_target}
        </span>
      </header>
      <div className="body">
        <fieldset className="radios" disabled={!canWrite || busy || refreshing}>
          <legend className="sr-only">{s.wt_title}</legend>
          {options.map((o) => (
            <label key={o.value} className={`radio${current === o.value ? " on" : ""}${o.enabled ? "" : " off"}`}>
              <input
                type="radio"
                name="writeTarget"
                value={o.value}
                checked={current === o.value}
                disabled={!o.enabled}
                onChange={() => choose(o.value)}
              />
              <span>
                <b>{o.label}</b>
                {!o.enabled && <span className="pill mute">{s.ms_not_connected}</span>}
                <small>{o.help}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="muted small">{s.wt_rollback_note}</p>
        <Message msg={msg} />
      </div>
    </section>
  );
}
