"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "../../../components/icons";

type Project = {
  id: string;
  name: string;
  baseUrl: string;
  pageCap: number;
  crawlRate: number;
};

export function Wizard({
  locale,
  project,
  wordpressConnected,
  hasRun,
  labels,
}: {
  locale: "fa" | "en";
  project: Project | null;
  wordpressConnected: boolean;
  hasRun: boolean;
  labels: Record<string, string>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "warn"; text: string; notes?: string[] } | null>(
    null,
  );

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy("project");
    setMessage(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: String(form.get("name") ?? ""),
          baseUrl: String(form.get("baseUrl") ?? ""),
          locale,
          pageCap: Number(form.get("pageCap") ?? 2000),
          crawlRate: Number(form.get("crawlRate") ?? 8),
        }),
      });
      const data = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        setMessage({ tone: "warn", text: data.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function connectWordpress(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project) return;
    const form = new FormData(event.currentTarget);
    setBusy("wp");
    setMessage(null);
    try {
      const res = await fetch(`/api/connectors/wordpress?projectId=${project.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "WORDPRESS",
          siteUrl: String(form.get("siteUrl") ?? project.baseUrl),
          username: String(form.get("username") ?? ""),
          applicationPassword: String(form.get("applicationPassword") ?? ""),
        }),
      });
      const data = (await res.json()) as {
        error?: { message?: string };
        status?: string;
        message?: string;
        capabilities?: { notes?: string[] };
      };
      if (!res.ok) {
        setMessage({ tone: "warn", text: data.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      setMessage({
        tone: data.status === "CONNECTED" ? "ok" : "warn",
        text: data.message ?? "",
        notes: data.capabilities?.notes,
      });
      if (data.status === "CONNECTED") router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function startScan() {
    if (!project) return;
    setBusy("scan");
    setMessage(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/scans`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ trigger: "MANUAL" }),
      });
      const data = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        setMessage({ tone: "warn", text: data.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      router.push("/audit");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {message && (
        <div className={`note ${message.tone === "ok" ? "acc" : "crit"}`}>
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
                <label className="field">
                  <span>{labels.pageCap}</span>
                  <select id="p-cap" name="pageCap" defaultValue="2000">
                    <option value="500">500</option>
                    <option value="2000">2000</option>
                    <option value="10000">10000</option>
                  </select>
                </label>
                <label className="field">
                  <span>{labels.crawlRate}</span>
                  <select id="p-rate" name="crawlRate" defaultValue="8">
                    <option value="2">2</option>
                    <option value="8">8</option>
                    <option value="16">16</option>
                  </select>
                </label>
              </div>
              <div>
                <button className="btn primary" type="submit" disabled={busy !== null}>
                  <Icon name="plus" />
                  {labels.next}
                </button>
              </div>
            </form>
          </div>
        </section>
      )}

      {project && !wordpressConnected && (
        <section className="card">
          <header>
            <h3>{labels.step2}</h3>
            <span className="sub">REST API + Application Password</span>
          </header>
          <div className="body">
            <form onSubmit={connectWordpress} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="grid g2" style={{ gap: 14 }}>
                <label className="field">
                  <span>{labels.siteUrl}</span>
                  <input id="wp-site-url" name="siteUrl" type="url" defaultValue={project.baseUrl} dir="ltr" />
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
                <div>
                  {locale === "fa"
                    ? "این اعتبارنامه رمزنگاری‌شده ذخیره می‌شود و فقط برای نوشتن اصلاح‌های مجاز به کار می‌رود. تا وقتی اتصال تست نشود چیزی ذخیره نمی‌شود."
                    : "The credential is stored encrypted and used only to write permitted fixes. Nothing is stored until the connection has been tested."}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn primary" type="submit" disabled={busy !== null}>
                  <Icon name="link" />
                  {labels.test}
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  onClick={startScan}
                  disabled={busy !== null}
                >
                  {labels.skip}
                </button>
              </div>
            </form>
          </div>
        </section>
      )}

      {project && (wordpressConnected || hasRun) && (
        <section className="card">
          <header>
            <h3>{labels.step4}</h3>
          </header>
          <div className="body">
            <p style={{ fontSize: 12.5, color: "var(--ink-2)", marginBottom: 14 }}>
              {locale === "fa"
                ? `پروژه «${project.name}» آماده است. اولین اسکن حداکثر ${project.pageCap} صفحه را با ${project.crawlRate} درخواست در ثانیه می‌خزد.`
                : `“${project.name}” is ready. The first scan crawls up to ${project.pageCap} pages at ${project.crawlRate} requests per second.`}
            </p>
            <button className="btn primary" onClick={startScan} disabled={busy !== null}>
              <Icon name="play" />
              {busy === "scan" ? "…" : labels.scan}
            </button>
          </div>
        </section>
      )}
    </>
  );
}
