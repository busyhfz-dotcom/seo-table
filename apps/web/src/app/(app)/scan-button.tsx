"use client";

/**
 * Starts a scan and reflects what the server said.
 *
 * A fresh idempotency key is generated per click, so a double-click cannot queue
 * two crawls, and a 409 is shown as the real reason (a scan is already running)
 * rather than a generic failure.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Icon } from "../../components/icons";

export function ScanButton({
  projectId,
  label,
  activeLabel,
}: {
  projectId: string;
  label: string;
  activeLabel: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/scans`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ trigger: "MANUAL" }),
      });
      const data = (await res.json()) as {
        error?: { message?: string };
        run?: { id: string };
        replayed?: boolean;
      };
      if (!res.ok) {
        setMessage(data.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      {message && (
        <span className="pill warn" role="status">
          <Icon name="alert" />
          {message}
        </span>
      )}
      <button className="btn primary" onClick={start} disabled={busy || pending}>
        <Icon name="play" />
        {busy || pending ? activeLabel : label}
      </button>
    </span>
  );
}
