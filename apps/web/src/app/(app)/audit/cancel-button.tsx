"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Icon } from "../../../components/icons";
import { apiErrorMessage, callApi } from "../../../lib/errors-ui";
import type { Locale } from "../../../lib/i18n";

export function CancelScanButton({ runId, locale, label }: { runId: string; locale: Locale; label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    const result = await callApi(`/api/scans/${runId}/cancel`, { method: "POST" });
    setBusy(false);
    if (!result.ok) {
      setError(apiErrorMessage(locale, result.failure));
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {error && (
        <span className="pill warn" role="status" style={{ whiteSpace: "normal" }}>
          <Icon name="alert" />
          {error}
        </span>
      )}
      <button className="btn ghost" onClick={cancel} disabled={busy || pending}>
        <Icon name="x" />
        {label}
      </button>
    </span>
  );
}
