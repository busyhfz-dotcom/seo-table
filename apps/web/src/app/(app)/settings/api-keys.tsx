"use client";

/**
 * The secret appears exactly once, in the response to its own creation, and is
 * held only in this component's state until the page is left. Nothing can read it
 * back afterwards — the server stores a hash.
 */
import { useEffect, useState } from "react";
import { Icon } from "../../../components/icons";

type Key = {
  id: string;
  name: string;
  masked: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export function ApiKeys({
  labels,
}: {
  labels: {
    title: string;
    create: string;
    name: string;
    once: string;
    revoke: string;
    empty: string;
    note: string;
  };
}) {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/keys");
    if (!res.ok) {
      setError(`HTTP ${res.status}`);
      setKeys([]);
      return;
    }
    const data = (await res.json()) as { keys: Key[] };
    setKeys(data.keys);
  }

  useEffect(() => {
    void load();
  }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = (await res.json()) as { error?: { message?: string }; secret?: string };
      if (!res.ok) {
        setError(data.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setFresh(data.secret ?? null);
      setName("");
      await load();
    } finally {
      setBusy(false);
    }
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
            <div>
              <div style={{ marginBottom: 6 }}>{labels.once}</div>
              <code className="path" style={{ userSelect: "all", wordBreak: "break-all" }} dir="ltr">
                {fresh}
              </code>
            </div>
          </div>
        )}

        {error && (
          <div className="note crit" style={{ marginBottom: 14 }}>
            <Icon name="alert" />
            <div>{error}</div>
          </div>
        )}

        <form onSubmit={create} style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 16 }}>
          <label className="field" style={{ flex: "1 1 200px" }}>
            <span>{labels.name}</span>
            <input id="key-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </label>
          <button className="btn primary" type="submit" disabled={busy || !name.trim()}>
            <Icon name="plus" />
            {labels.create}
          </button>
        </form>

        {keys === null ? (
          <div style={{ color: "var(--ink-3)", fontSize: 12.5 }}>…</div>
        ) : keys.length === 0 ? (
          <div className="empty">
            <Icon name="key" />
            <div>{labels.empty}</div>
          </div>
        ) : (
          <div className="tw">
            <table>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td className="path" dir="ltr">
                      {k.masked}
                    </td>
                    <td style={{ color: "var(--ink-3)", fontSize: 12 }}>
                      {k.revokedAt ? (
                        <span className="pill mute">
                          <Icon name="x" />
                          {labels.revoke}
                        </span>
                      ) : (
                        new Date(k.createdAt).toISOString().slice(0, 10)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
