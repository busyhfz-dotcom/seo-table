"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Icon } from "../../../components/icons";
import { apiErrorMessage, callApi } from "../../../lib/errors-ui";
import { num } from "../../../lib/format";
import type { Locale } from "../../../lib/i18n";

type Project = {
  id: string;
  name: string;
  baseUrl: string;
  pageCap: number;
  crawlRate: number;
};

const PAGE_CAPS = [500, 2000, 10000];
const CRAWL_RATES = [2, 8, 16];

export function Wizard({
  locale,
  project,
  wordpressConnected,
  skippedWordpress,
  hasRun,
  labels,
}: {
  locale: Locale;
  project: Project | null;
  wordpressConnected: boolean;
  skippedWordpress: boolean;
  hasRun: boolean;
  labels: Record<
    | "step1"
    | "step2"
    | "step3"
    | "step4"
    | "projectLang"
    | "langFa"
    | "langEn"
    | "siteUrl"
    | "username"
    | "appPassword"
    | "pageCap"
    | "crawlRate"
    | "next"
    | "skip"
    | "scan"
    | "test"
    | "name"
    | "ready"
    | "credNote",
    string
  >;
}) {
  const router = useRouter();
  const [navigating, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "warn"; text: string; notes?: string[] } | null>(null);
  const locked = busy !== null || navigating;

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy("project");
    setMessage(null);
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
    if (!result.ok) {
      setMessage({ tone: "warn", text: apiErrorMessage(locale, result.failure) });
      return;
    }
    // Continue with the project just created, whichever project is the default.
    startTransition(() => router.push(`/onboarding?project=${encodeURIComponent(result.data.project.id)}`));
  }

  async function connectWordpress(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project) return;
    const form = new FormData(event.currentTarget);
    setBusy("wp");
    setMessage(null);
    const result = await callApi<{ status?: string; message?: string; capabilities?: { notes?: string[] } | null }>(
      `/api/connectors/wordpress?projectId=${encodeURIComponent(project.id)}`,
      {
        method: "POST",
        body: {
          kind: "WORDPRESS",
          siteUrl: String(form.get("siteUrl") ?? project.baseUrl),
          username: String(form.get("username") ?? ""),
          applicationPassword: String(form.get("applicationPassword") ?? ""),
        },
      },
    );
    setBusy(null);
    if (!result.ok) {
      setMessage({ tone: "warn", text: apiErrorMessage(locale, result.failure) });
      return;
    }
    // The server already words the outcome in the reader's language.
    setMessage({
      tone: result.data.status === "CONNECTED" ? "ok" : "warn",
      text: result.data.message ?? "",
      ...(result.data.capabilities?.notes ? { notes: result.data.capabilities.notes } : {}),
    });
    if (result.data.status === "CONNECTED") startTransition(() => router.refresh());
  }

  function skipWordpress() {
    if (!project) return;
    startTransition(() => router.push(`/onboarding?project=${encodeURIComponent(project.id)}&wp=skip`));
  }

  async function startScan() {
    if (!project) return;
    setBusy("scan");
    setMessage(null);
    const result = await callApi(`/api/projects/${project.id}/scans`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: { trigger: "MANUAL" },
    });
    setBusy(null);
    if (!result.ok) {
      setMessage({ tone: "warn", text: apiErrorMessage(locale, result.failure) });
      return;
    }
    startTransition(() => router.push(`/audit?project=${encodeURIComponent(project.id)}`));
  }

  return (
    <>
      {message && (
        <div className={`note ${message.tone === "ok" ? "acc" : "crit"}`} role="status">
          <Icon name={message.tone === "ok" ? "check" : "alert"} />
          <div>
            {message.text}
            {message.notes && message.notes.length > 0 && (
              <ul className="plain" style={{ marginTop: 6 }}>
                {message.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {!project && (
        <section className="card">
          <header>
            <h3>{labels.step1}</h3>
          </header>
          <div className="body">
            <form onSubmit={createProject} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="grid g2" style={{ gap: 14 }}>
                <label className="field">
                  <span>{labels.name}</span>
                  <input id="p-name" name="name" required maxLength={120} />
                </label>
                <label className="field">
                  <span>{labels.siteUrl}</span>
                  <input id="p-url" name="baseUrl" type="url" required dir="ltr" placeholder="https://example.ir" />
                </label>
              </div>

              <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
                <legend style={{ fontSize: 13, fontWeight: 500, marginBottom: 10, padding: 0 }}>{labels.step3}</legend>
                <div className="grid g3" style={{ gap: 14 }}>
                  <label className="field">
                    <span>{labels.projectLang}</span>
                    <select id="p-locale" name="locale" defaultValue={locale}>
                      <option value="fa">{labels.langFa}</option>
                      <option value="en">{labels.langEn}</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>{labels.pageCap}</span>
                    <select id="p-cap" name="pageCap" defaultValue="2000">
                      {PAGE_CAPS.map((v) => (
                        <option key={v} value={v}>
                          {num(v, locale)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>{labels.crawlRate}</span>
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

              <div>
                <button className="btn primary" type="submit" disabled={locked}>
                  <Icon name="plus" />
                  {labels.next}
                </button>
              </div>
            </form>
          </div>
        </section>
      )}

      {project && !wordpressConnected && !skippedWordpress && !hasRun && (
        <section className="card">
          <header>
            <h3>{labels.step2}</h3>
            <span className="sub" dir="ltr">
              REST API + Application Password
            </span>
          </header>
          <div className="body">
            <form onSubmit={connectWordpress} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="grid g2" style={{ gap: 14 }}>
                <label className="field">
                  <span>{labels.siteUrl}</span>
                  <input
                    id="wp-site-url"
                    name="siteUrl"
                    type="url"
                    required
                    defaultValue={project.baseUrl}
                    dir="ltr"
                  />
                </label>
                <label className="field">
                  <span>{labels.username}</span>
                  <input id="wp-username" name="username" required dir="ltr" autoComplete="off" />
                </label>
                <label className="field">
                  <span>{labels.appPassword}</span>
                  <input
                    id="wp-app-password"
                    name="applicationPassword"
                    type="password"
                    required
                    dir="ltr"
                    autoComplete="off"
                  />
                </label>
              </div>
              <div className="note lock">
                <Icon name="lock" />
                <div>{labels.credNote}</div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn primary" type="submit" disabled={locked}>
                  <Icon name="link" />
                  {labels.test}
                </button>
                <button className="btn ghost" type="button" onClick={skipWordpress} disabled={locked}>
                  {labels.skip}
                </button>
              </div>
            </form>
          </div>
        </section>
      )}

      {project && (wordpressConnected || skippedWordpress || hasRun) && (
        <section className="card">
          <header>
            <h3>{labels.step4}</h3>
          </header>
          <div className="body">
            <p style={{ fontSize: 12.5, color: "var(--ink-2)", marginBottom: 14 }}>{labels.ready}</p>
            <button className="btn primary" onClick={startScan} disabled={locked}>
              <Icon name="play" />
              {labels.scan}
            </button>
          </div>
        </section>
      )}
    </>
  );
}
