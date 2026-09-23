"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Icon } from "../../../components/icons";
import { Fill, UserText } from "../../../components/ui";
import { apiErrorMessage, callApi } from "../../../lib/errors-ui";
import { num } from "../../../lib/format";
import type { Locale } from "../../../lib/i18n";
import type { ConnectStrings } from "../connect/keys";
import type { ConnectionView, MethodView } from "../connect/load";
import { BridgeMethod, CloudflareMethod, FixPackMethod, PlatformCard, WordPressMethod } from "../connect/methods";
import { ConnectProvider, Message, Spinner, useConnect, type Msg } from "../connect/parts";

type Project = { id: string; name: string; pageCap: number; crawlRate: number };

const PAGE_CAPS = [500, 2000, 10000];
const CRAWL_RATES = [2, 8, 16];

export function Wizard({
  locale,
  phase,
  view,
  project,
  s,
  canWrite,
  canRun,
}: {
  locale: Locale;
  phase: "add" | "connect" | "scan";
  view: ConnectionView | null;
  project: Project | null;
  s: ConnectStrings;
  canWrite: boolean;
  canRun: boolean;
}) {
  const router = useRouter();
  const [navigating, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  const locked = busy !== null || navigating;

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy("project");
    setMsg(null);
    const result = await callApi<{ project: { id: string } }>("/api/projects", {
      method: "POST",
      body: {
        name: String(form.get("name") ?? ""),
        baseUrl: String(form.get("baseUrl") ?? ""),
        locale: String(form.get("locale") ?? locale),
        pageCap: Number(form.get("pageCap") ?? 2000),
        crawlRate: Number(form.get("crawlRate") ?? 8),
      },
    });
    setBusy(null);
    if (!result.ok) return setMsg({ tone: "crit", text: apiErrorMessage(locale, result.failure) });
    // Continue with the project just created, whichever project is the default.
    startTransition(() => router.push(`/onboarding?project=${encodeURIComponent(result.data.project.id)}`));
  }

  function skipConnect() {
    if (!project) return;
    startTransition(() => router.push(`/onboarding?project=${encodeURIComponent(project.id)}&connect=skip`));
  }

  async function startScan() {
    if (!project) return;
    setBusy("scan");
    setMsg(null);
    const result = await callApi(`/api/projects/${project.id}/scans`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: { trigger: "MANUAL" },
    });
    setBusy(null);
    if (!result.ok) return setMsg({ tone: "crit", text: apiErrorMessage(locale, result.failure) });
    startTransition(() => router.push(`/audit?project=${encodeURIComponent(project.id)}`));
  }

  if (phase === "add" || !project || !view) {
    return (
      <section className="card">
        <header>
          <h3>{s.ob_step1}</h3>
        </header>
        <div className="body">
          <form onSubmit={createProject} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="grid g2" style={{ gap: 14 }}>
              <label className="field">
                <span>{s.project_name}</span>
                <input id="p-name" name="name" required maxLength={120} />
              </label>
              <label className="field">
                <span>{s.site_url}</span>
                <input id="p-url" name="baseUrl" type="url" required dir="ltr" placeholder="https://example.ir" />
              </label>
            </div>

            <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <legend style={{ fontSize: 13, fontWeight: 500, marginBottom: 10, padding: 0 }}>{s.ob_limits}</legend>
              <div className="grid g3" style={{ gap: 14 }}>
                <label className="field">
                  <span>{s.project_lang}</span>
                  <select id="p-locale" name="locale" defaultValue={locale}>
                    <option value="fa">{s.lang_fa}</option>
                    <option value="en">{s.lang_en}</option>
                  </select>
                </label>
                <label className="field">
                  <span>{s.page_cap}</span>
                  <select id="p-cap" name="pageCap" defaultValue="2000">
                    {PAGE_CAPS.map((v) => (
                      <option key={v} value={v}>
                        {num(v, locale)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>{s.crawl_rate}</span>
                  <select id="p-rate" name="crawlRate" defaultValue="8">
                    {CRAWL_RATES.map((v) => (
                      <option key={v} value={v}>
                        {num(v, locale)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </fieldset>

            <Message msg={msg} />
            <div>
              <button className="btn primary" type="submit" disabled={locked}>
                {busy === "project" ? <Spinner /> : <Icon name="plus" />}
                {s.ob_next}
              </button>
            </div>
          </form>
        </div>
      </section>
    );
  }

  return (
    <ConnectProvider value={{ s, locale, projectId: project.id, baseUrl: view.baseUrl, canWrite, canRun }}>
      {phase === "connect" ? (
        <ConnectStep view={view} onSkip={skipConnect} locked={locked} />
      ) : (
        <section className="card">
          <header>
            <h3>{s.ob_step4}</h3>
          </header>
          <div className="body" style={{ display: "flex", flexDirection: "column", gap: 14, alignItems: "flex-start" }}>
            <p className="desc">
              <Fill
                template={s.ob_ready}
                slots={{
                  name: <UserText>{project.name}</UserText>,
                  cap: num(project.pageCap, locale),
                  rate: num(project.crawlRate, locale),
                }}
              />
            </p>
            <Message msg={msg} />
            <button className="btn primary" onClick={startScan} disabled={locked || !canRun}>
              {busy === "scan" ? <Spinner /> : <Icon name="play" />}
              {s.scan}
            </button>
          </div>
        </section>
      )}
    </ConnectProvider>
  );
}

function MethodFor({ method, view }: { method: MethodView; view: ConnectionView }) {
  switch (method.kind) {
    case "CLOUDFLARE":
      return <CloudflareMethod method={method} />;
    case "WORDPRESS":
      return <WordPressMethod method={method} platform={view.platform} />;
    case "WORDPRESS_BRIDGE":
      return <BridgeMethod method={method} wordpress={view.methods.find((m) => m.kind === "WORDPRESS")} />;
    default:
      return <FixPackMethod method={method} pack={view.fixPack} />;
  }
}

/**
 * Detection, then the method recommended for this site in full, the other
 * routes one click away, and a way to go on without connecting anything.
 */
function ConnectStep({ view, onSkip, locked }: { view: ConnectionView; onSkip: () => void; locked: boolean }) {
  const { s } = useConnect();
  const recommended = view.methods.find((m) => m.recommended);
  // WordPress stays offered even when detection says otherwise: its card can connect anyway.
  const applicable = view.methods.filter((m) => m.status !== "not_applicable" || m.kind === "WORDPRESS");
  const others = applicable.filter((m) => m !== recommended);
  const [open, setOpen] = useState<string | null>(recommended ? null : (others[0]?.kind ?? null));

  return (
    <>
      <PlatformCard platform={view.platform} detectedLabel={view.detectedLabel} compact />

      {recommended && (
        <div className="approach">
          <div className="approach-h">
            <Icon name="check" />
            <div>
              <h2>{s.ob_recommend}</h2>
              <p>{recommended.approach === "plugin" ? s.cn_plugin_sub : s.cn_noinstall_sub}</p>
            </div>
          </div>
          <MethodFor method={recommended} view={view} />
        </div>
      )}

      {others.length > 0 && (
        <section className="card stack">
          <header>
            <h3>{recommended ? s.ob_other_methods : s.ob_step3}</h3>
          </header>
          <div className="body">
            <div className="seg" role="group" aria-label={recommended ? s.ob_other_methods : s.ob_step3}>
              {others.map((m) => (
                <button
                  key={m.kind}
                  type="button"
                  aria-pressed={open === m.kind}
                  onClick={() => setOpen(open === m.kind ? null : m.kind)}
                >
                  {s[`m_${m.kind}`]}
                </button>
              ))}
            </div>
            {others.map((m) => (open === m.kind ? <MethodFor key={m.kind} method={m} view={view} /> : null))}
          </div>
        </section>
      )}

      <section className="card stack">
        <div className="body">
          <p className="muted">{s.ob_skip_note}</p>
          <div className="row">
            <button className="btn ghost" type="button" onClick={onSkip} disabled={locked}>
              <Icon name="play" />
              {recommended?.kind === "FIX_PACK" ? s.ob_continue : s.ob_connect_later}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
