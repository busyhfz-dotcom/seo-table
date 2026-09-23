"use client";

/**
 * Google Search Console inside the panel: connect it with a service account,
 * submit a sitemap, and ask Google whether a URL is indexed. Google's verdicts
 * and states are enums, worded here in the reader's language.
 */
import { useState } from "react";
import { Icon } from "../../../components/icons";
import { Fill, UserText } from "../../../components/ui";
import { apiErrorMessage, callApi } from "../../../lib/errors-ui";
import { dateTime } from "../../../lib/format";
import type { Locale } from "../../../lib/i18n";
import { readableUrl } from "../../../lib/labels";
import { Message, Spinner, useConnect, useRefresh, type Msg } from "./parts";

type Pair = { fa: string; en: string };

/** Google's URL Inspection enums (indexStatusResult, mobileUsabilityResult, richResultsResult). */
const VERDICT: Record<string, Pair> = {
  PASS: { fa: "نشانی در گوگل است", en: "URL is on Google" },
  PARTIAL: { fa: "نشانی در گوگل است، اما مشکلاتی دارد", en: "URL is on Google, but has issues" },
  FAIL: { fa: "نشانی در گوگل نیست", en: "URL is not on Google" },
  NEUTRAL: { fa: "از ایندکس کنار گذاشته شده", en: "Excluded from the index" },
  VERDICT_UNSPECIFIED: { fa: "نامشخص", en: "Unknown" },
};
const CHECK_VERDICT: Record<string, Pair> = {
  PASS: { fa: "بدون مشکل", en: "No issues" },
  PARTIAL: { fa: "با هشدار", en: "With warnings" },
  FAIL: { fa: "دارای خطا", en: "Has errors" },
  NEUTRAL: { fa: "بررسی نشد", en: "Not checked" },
  VERDICT_UNSPECIFIED: { fa: "نامشخص", en: "Unknown" },
};
const INDEXING: Record<string, Pair> = {
  INDEXING_ALLOWED: { fa: "مجاز", en: "Allowed" },
  BLOCKED_BY_META_TAG: { fa: "مسدود با متای noindex", en: "Blocked by a noindex meta tag" },
  BLOCKED_BY_HTTP_HEADER: { fa: "مسدود با هدر HTTP", en: "Blocked by an HTTP header" },
  BLOCKED_BY_ROBOTS_TXT: { fa: "مسدود با robots.txt", en: "Blocked by robots.txt" },
  INDEXING_STATE_UNSPECIFIED: { fa: "نامشخص", en: "Unknown" },
};
const ROBOTS: Record<string, Pair> = {
  ALLOWED: { fa: "مجاز", en: "Allowed" },
  DISALLOWED: { fa: "مسدود", en: "Disallowed" },
  ROBOTS_TXT_STATE_UNSPECIFIED: { fa: "نامشخص", en: "Unknown" },
};
const FETCH: Record<string, Pair> = {
  SUCCESSFUL: { fa: "موفق", en: "Successful" },
  SOFT_404: { fa: "صفحه‌ی خالی یا «پیدا نشد» (۴۰۴ نرم)", en: "Soft 404" },
  BLOCKED_ROBOTS_TXT: { fa: "مسدود با robots.txt", en: "Blocked by robots.txt" },
  NOT_FOUND: { fa: "پیدا نشد (۴۰۴)", en: "Not found (404)" },
  ACCESS_DENIED: { fa: "نیازمند ورود (۴۰۱)", en: "Access denied (401)" },
  ACCESS_FORBIDDEN: { fa: "دسترسی ممنوع (۴۰۳)", en: "Forbidden (403)" },
  SERVER_ERROR: { fa: "خطای سرور", en: "Server error" },
  REDIRECT_ERROR: { fa: "خطای ریدایرکت", en: "Redirect error" },
  BLOCKED_4XX: { fa: "خطای سمت درخواست (۴۰۰ تا ۴۹۹)", en: "Client error (4xx)" },
  INTERNAL_CRAWL_ERROR: { fa: "خطای داخلی خزنده‌ی گوگل", en: "Google's internal crawl error" },
  INVALID_URL: { fa: "نشانی نامعتبر", en: "Invalid URL" },
  PAGE_FETCH_STATE_UNSPECIFIED: { fa: "نامشخص", en: "Unknown" },
};
const CRAWLED_AS: Record<string, Pair> = {
  DESKTOP: { fa: "خزنده‌ی دسکتاپ", en: "Desktop crawler" },
  MOBILE: { fa: "خزنده‌ی موبایل", en: "Smartphone crawler" },
  CRAWLING_USER_AGENT_UNSPECIFIED: { fa: "نامشخص", en: "Unknown" },
};

function word(map: Record<string, Pair>, value: string | null, locale: Locale): string | null {
  if (!value) return null;
  return map[value]?.[locale] ?? value;
}

type Inspection = {
  url: string;
  verdict: string | null;
  coverageState: string | null;
  indexingState: string | null;
  robotsTxtState: string | null;
  pageFetchState: string | null;
  lastCrawlTime: string | null;
  crawledAs: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  sitemaps: string[];
  referringUrls: string[];
  mobileUsabilityVerdict: string | null;
  richResults: { verdict: string | null; types: string[] };
  inspectionResultLink: string | null;
};

export function SearchConsoleCard({ status, lastError }: { status: string; lastError: string | null }) {
  const { s } = useConnect();
  const connected = status === "CONNECTED";
  return (
    <section className="card stack" id="search-console">
      <header>
        <span className="mico" aria-hidden="true">
          <Icon name="search" />
        </span>
        <h3>{s.sc_title}</h3>
        <span className="spacer" />
        <span className={`pill ${connected ? "ok" : status === "ERROR" ? "crit" : "mute"}`}>
          <Icon name={connected ? "check" : status === "ERROR" ? "alert" : "x"} />
          {connected ? s.ms_connected : status === "ERROR" ? s.ms_error : s.ms_not_connected}
        </span>
      </header>
      <div className="body">
        <p className="desc">{s.sc_intro}</p>
        {lastError && status === "ERROR" && <Message msg={{ tone: "crit", text: lastError }} />}
        {connected ? (
          <div className="grid g2 tight">
            <SitemapForm />
            <InspectForm />
          </div>
        ) : (
          <GoogleConnectForm kind="SEARCH_CONSOLE" />
        )}
      </div>
    </section>
  );
}

/**
 * Search Console or GA4 with a Google service account key. Only the three
 * fields the API needs leave the page; the pasted file itself is never sent.
 */
export function GoogleConnectForm({ kind }: { kind: "SEARCH_CONSOLE" | "GA4" }) {
  const { s, locale, projectId, baseUrl, canWrite } = useConnect();
  const [, refresh] = useRefresh();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  if (!canWrite) return <p className="muted">{s.cn_no_permission}</p>;
  const host = new URL(baseUrl).hostname.replace(/^www\./, "");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let key: { type?: string; client_email?: string; private_key?: string };
    try {
      key = JSON.parse(String(form.get("key") ?? ""));
    } catch {
      return setMsg({ tone: "crit", text: s.sc_key_invalid });
    }
    if (key.type !== "service_account" || !key.client_email || !key.private_key) {
      return setMsg({ tone: "crit", text: s.sc_key_invalid });
    }
    const google = { type: "service_account", client_email: key.client_email, private_key: key.private_key };
    const target = String(form.get("target") ?? "").trim();
    setBusy(true);
    setMsg(null);
    const res = await callApi<{ status: string; message: string }>(
      `/api/connectors/${kind}?projectId=${encodeURIComponent(projectId)}`,
      { method: "POST", body: kind === "GA4" ? { kind, propertyId: target, google } : { kind, siteUrl: target, google } },
    );
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "crit", text: apiErrorMessage(locale, res.failure) });
    const ok = res.data.status === "CONNECTED";
    setMsg({ tone: ok ? "ok" : "crit", text: res.data.message });
    if (ok) refresh();
  }

  return (
    <form className="guided" onSubmit={submit}>
      <label className="field">
        <span>{kind === "GA4" ? s.sc_ga4_property : s.sc_property}</span>
        <input
          name="target"
          required
          dir="ltr"
          spellCheck={false}
          {...(kind === "GA4" ? { inputMode: "numeric" as const, pattern: "[0-9]+" } : {})}
        />
        {kind === "SEARCH_CONSOLE" && (
          <small className="muted">
            <Fill
              template={s.sc_property_help}
              slots={{ a: <code dir="ltr">sc-domain:{host}</code>, b: <code dir="ltr">{new URL(baseUrl).origin}/</code> }}
            />
          </small>
        )}
      </label>
      <label className="field">
        <span>{s.sc_key}</span>
        <textarea name="key" required rows={4} dir="ltr" spellCheck={false} placeholder={s.sc_key_placeholder} />
        <small className="muted">{kind === "GA4" ? s.sc_ga4_key_help : s.sc_key_help}</small>
      </label>
      <p className="muted small">{s.cn_secret_note}</p>
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? <Spinner /> : <Icon name="link" />}
          {s.cn_verify_connect}
        </button>
      </div>
      <Message msg={msg} />
    </form>
  );
}

function SitemapForm() {
  const { s, locale, projectId, baseUrl, canWrite } = useConnect();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const sitemapUrl = String(new FormData(event.currentTarget).get("sitemapUrl") ?? "").trim();
    setBusy(true);
    setMsg(null);
    const res = await callApi<{ ok: boolean; message?: string }>(`/api/projects/${projectId}/search-console/sitemaps`, {
      method: "POST",
      body: { sitemapUrl },
    });
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "crit", text: apiErrorMessage(locale, res.failure) });
    setMsg(res.data.ok ? { tone: "ok", text: s.sc_submitted } : { tone: "crit", text: res.data.message ?? "" });
  }

  return (
    <form className="tool" onSubmit={submit}>
      <h4>{s.sc_sitemap}</h4>
      <label className="field">
        <span>{s.sc_sitemap_url}</span>
        <input name="sitemapUrl" type="url" required dir="ltr" defaultValue={`${new URL(baseUrl).origin}/sitemap.xml`} />
      </label>
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy || !canWrite}>
          {busy ? <Spinner /> : <Icon name="play" />}
          {s.sc_submit}
        </button>
      </div>
      {!canWrite && <p className="muted small">{s.cn_no_permission}</p>}
      <Message msg={msg} />
    </form>
  );
}

function InspectForm() {
  const { s, locale, projectId, baseUrl, canRun } = useConnect();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [result, setResult] = useState<Inspection | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = String(new FormData(event.currentTarget).get("url") ?? "").trim();
    setBusy(true);
    setMsg(null);
    setResult(null);
    const res = await callApi<{ ok: boolean; message?: string; inspection?: Inspection }>(
      `/api/projects/${projectId}/search-console/inspect`,
      { method: "POST", body: { url } },
    );
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "crit", text: apiErrorMessage(locale, res.failure) });
    if (!res.data.ok || !res.data.inspection) return setMsg({ tone: "crit", text: res.data.message ?? "" });
    setResult(res.data.inspection);
  }

  return (
    <form className="tool" onSubmit={submit} aria-busy={busy}>
      <h4>{s.sc_inspect}</h4>
      <label className="field">
        <span>{s.page_url}</span>
        <input name="url" type="url" required dir="ltr" defaultValue={baseUrl} />
      </label>
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy || !canRun}>
          {busy ? <Spinner /> : <Icon name="search" />}
          {s.sc_inspect_run}
        </button>
        {busy && <span className="muted small">{s.sc_inspecting}</span>}
      </div>
      <Message msg={msg} />
      {result && <InspectionResult r={result} />}
    </form>
  );
}

function InspectionResult({ r }: { r: Inspection }) {
  const { s, locale } = useConnect();
  const tone = r.verdict === "PASS" ? "ok" : r.verdict === "PARTIAL" || r.verdict === "NEUTRAL" ? "warn" : "crit";
  const url = (u: string | null) =>
    u ? (
      <span className="url" dir="ltr" translate="no">
        {readableUrl(u)}
      </span>
    ) : (
      "—"
    );
  const rows: Array<[string, React.ReactNode]> = [
    [s.sc_coverage, r.coverageState ? <UserText>{r.coverageState}</UserText> : "—"],
    [s.sc_indexing, word(INDEXING, r.indexingState, locale) ?? "—"],
    [s.sc_robots, word(ROBOTS, r.robotsTxtState, locale) ?? "—"],
    [s.sc_fetch, word(FETCH, r.pageFetchState, locale) ?? "—"],
    [s.sc_last_crawl, r.lastCrawlTime ? dateTime(r.lastCrawlTime, locale) : s.sc_never],
    [s.sc_crawled_as, word(CRAWLED_AS, r.crawledAs, locale) ?? "—"],
    [s.sc_google_canonical, url(r.googleCanonical)],
    [s.sc_user_canonical, url(r.userCanonical)],
    [s.sc_mobile, word(CHECK_VERDICT, r.mobileUsabilityVerdict, locale) ?? "—"],
    [
      s.sc_rich,
      r.richResults.verdict ? (
        <>
          {word(CHECK_VERDICT, r.richResults.verdict, locale)}
          {r.richResults.types.length > 0 && <UserText> · {r.richResults.types.join(", ")}</UserText>}
        </>
      ) : (
        "—"
      ),
    ],
  ];
  return (
    <div className="inspection" role="status">
      <div className={`verdict ${tone}`}>
        <Icon name={tone === "ok" ? "check" : "alert"} />
        <b>{word(VERDICT, r.verdict, locale) ?? "—"}</b>
      </div>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k} className="kvrow">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {r.sitemaps.length > 0 && (
        <div>
          <div className="caps-h">{s.sc_sitemaps}</div>
          <ul className="codes">
            {r.sitemaps.map((u) => (
              <li key={u}>{url(u)}</li>
            ))}
          </ul>
        </div>
      )}
      {r.referringUrls.length > 0 && (
        <div>
          <div className="caps-h">{s.sc_referring}</div>
          <ul className="codes">
            {r.referringUrls.slice(0, 5).map((u) => (
              <li key={u}>{url(u)}</li>
            ))}
          </ul>
        </div>
      )}
      {r.inspectionResultLink && (
        <a className="btn ghost sm" href={r.inspectionResultLink} target="_blank" rel="noreferrer noopener">
          <Icon name="external" />
          {s.sc_open_gsc}
        </a>
      )}
    </div>
  );
}
