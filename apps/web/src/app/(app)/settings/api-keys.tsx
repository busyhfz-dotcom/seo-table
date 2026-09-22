"use client";

/**
 * The secret appears exactly once, in the response to its own creation, and is
 * held only in this component's state until the page is left. Nothing can read it
 * back afterwards — the server stores a hash. Revoking keeps the row (marked
 * revoked) so the audit trail still says which key did what.
 */
import { useEffect, useState } from "react";
import { Icon } from "../../../components/icons";
import { apiErrorMessage, callApi } from "../../../lib/errors-ui";
import { dateTime } from "../../../lib/format";
import type { Locale } from "../../../lib/i18n";

type Key = {
  id: string;
  name: string;
  masked: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

type Labels = {
  title: string;
  create: string;
  name: string;
  key: string;
  created: string;
  lastUsed: string;
  never: string;
  once: string;
  revoke: string;
  revoked: string;
  confirm: string;
  cancel: string;
  empty: string;
  note: string;
};

export function ApiKeys({ locale, labels }: { locale: Locale; labels: Labels }) {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const result = await callApi<{ keys: Key[] }>("/api/keys");
    if (!result.ok) {
      setError(apiErrorMessage(locale, result.failure));
      setKeys([]);
      return;
    }
    setKeys(result.data.keys);
  }

  useEffect(() => {
    void load();
    // Loaded once on mount; later changes reload explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    const result = await callApi<{ secret?: string }>("/api/keys", { method: "POST", body: { name } });
    if (!result.ok) {
      setError(apiErrorMessage(locale, result.failure));
      setBusy(false);
      return;
    }
    setFresh(result.data.secret ?? null);
    setName("");
    await load();
    setBusy(false);
  }

  async function revoke(id: string) {
    setBusy(true);
    setError(null);
    const result = await callApi<{ id: string; revokedAt: string | null }>(`/api/keys/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    setConfirming(null);
    if (!result.ok) {
      setError(apiErrorMessage(locale, result.failure));
      setBusy(false);
      return;
    }
    await load();
    setBusy(false);
  }

  return (
    <section className="card">
      <header>
        <h3>{labels.title}</h3>
      </header>
      <div className="body">
        <div className="note" style={{ marginBottom: 14 }}>
          <Icon name="info" />
          <div>{labels.note}</div>
        </div>

        {fresh && (
          <div className="note acc" style={{ marginBottom: 14 }}>
            <Icon name="key" />
            <div style={{ minWidth: 0 }}>
              <div style={{ marginBottom: 6 }}>{labels.once}</div>
              <code className="path" style={{ userSelect: "all", wordBreak: "break-all" }} dir="ltr">
                {fresh}
              </code>
            </div>
          </div>
        )}

        {error && (
          <div className="note crit" style={{ marginBottom: 14 }} role="status">
            <Icon name="alert" />
            <div>{error}</div>
          </div>
        )}

        <form onSubmit={create} style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 16, flexWrap: "wrap" }}>
          <label className="field" style={{ flex: "1 1 200px" }}>
            <span>{labels.name}</span>
            <input id="key-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </label>
          <button className="btn primary" type="submit" disabled={busy || !name.trim()}>
            <Icon name="plus" />
            {labels.create}
          </button>
        </form>
      </div>

      {keys === null ? (
        <div className="body" style={{ color: "var(--ink-3)", fontSize: 12.5, paddingTop: 0 }}>
          …
        </div>
      ) : keys.length === 0 ? (
        <div className="empty">
          <Icon name="key" />
          <div>{labels.empty}</div>
        </div>
      ) : (
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>{labels.name}</th>
                <th>{labels.key}</th>
                <th>{labels.created}</th>
                <th>{labels.lastUsed}</th>
                <th aria-label={labels.revoke} />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} style={k.revokedAt ? { opacity: 0.6 } : undefined}>
                  <td>{k.name}</td>
                  <td className="path" dir="ltr">
                    {k.masked}
                  </td>
                  <td style={{ color: "var(--ink-3)", fontSize: 12, whiteSpace: "nowrap" }}>
                    {dateTime(k.createdAt, locale)}
                  </td>
                  <td style={{ color: "var(--ink-3)", fontSize: 12, whiteSpace: "nowrap" }}>
                    {k.lastUsedAt ? dateTime(k.lastUsedAt, locale) : labels.never}
                  </td>
                  <td style={{ textAlign: "end", whiteSpace: "nowrap" }}>
                    {k.revokedAt ? (
                      <span className="pill mute" title={dateTime(k.revokedAt, locale)}>
                        <Icon name="x" />
                        {labels.revoked}
                      </span>
                    ) : confirming === k.id ? (
                      <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{labels.confirm}</span>
                        <button className="btn danger sm" onClick={() => revoke(k.id)} disabled={busy}>
                          {labels.revoke}
                        </button>
                        <button className="btn ghost sm" onClick={() => setConfirming(null)} disabled={busy}>
                          {labels.cancel}
                        </button>
                      </span>
                    ) : (
                      <button
                        className="btn ghost sm"
                        onClick={() => setConfirming(k.id)}
                        disabled={busy}
                        aria-label={`${labels.revoke}: ${k.name}`}
                      >
                        <Icon name="x" />
                        {labels.revoke}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
