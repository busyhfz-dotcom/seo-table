"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "../../../components/icons";

export function CancelScanButton({ runId, label }: { runId: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/scans/${runId}/cancel`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json()) as { error?: { message?: string } };
        setError(data.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      {error && (
        <span className="pill warn" role="status">
          <Icon name="alert" />
          {error}
        </span>
      )}
      <button className="btn ghost" onClick={cancel} disabled={busy}>
        <Icon name="x" />
        {label}
      </button>
    </span>
  );
}
