"use client";

/**
 * The credential never reaches component state beyond the input itself, and the
 * response contains no credential material — only whether the connection worked
 * and what the site supports.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "../../../components/icons";

export function WordPressForm({
  projectId,
  connected,
  labels,
}: {
  projectId: string;
  connected: boolean;
  labels: {
    siteUrl: string;
    username: string;
    appPassword: string;
    test: string;
    connect: string;
    manage: string;
  };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(!connected);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; notes?: string[] } | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/connectors/wordpress?projectId=${projectId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "WORDPRESS",
          siteUrl: String(form.get("siteUrl") ?? ""),
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
        setResult({ ok: false, message: data.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      setResult({
        ok: data.status === "CONNECTED",
        message: data.message ?? "",
        notes: data.capabilities?.notes ?? [],
      });
      if (data.status === "CONNECTED") {
        setOpen(false);
        router.refresh();
      }
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div style={{ marginTop: 4 }}>
        <button className="btn ghost" onClick={() => setOpen(true)}>
          <Icon name="gear" />
          {labels.manage}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
      <label className="field">
        <span>{labels.siteUrl}</span>
        <input id="wp-site" name="siteUrl" type="url" required dir="ltr" placeholder="https://example.ir" />
      </label>
      <label className="field">
        <span>{labels.username}</span>
        <input id="wp-user" name="username" required dir="ltr" autoComplete="off" />
      </label>
      <label className="field">
        <span>{labels.appPassword}</span>
        <input
          id="wp-pass"
          name="applicationPassword"
          type="password"
          required
          dir="ltr"
          autoComplete="off"
          placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
        />
      </label>

      {result && (
        <div className={`note${result.ok ? " acc" : " crit"}`}>
          <Icon name={result.ok ? "check" : "alert"} />
          <div>
            {result.message}
            {result.notes && result.notes.length > 0 && (
              <ul className="plain" style={{ marginTop: 6 }}>
                {result.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary" type="submit" disabled={busy}>
          <Icon name="link" />
          {busy ? "…" : labels.test}
        </button>
      </div>
    </form>
  );
}
