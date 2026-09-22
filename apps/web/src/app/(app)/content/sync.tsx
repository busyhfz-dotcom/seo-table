"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Icon } from "../../../components/icons";
import { apiErrorMessage, callApi } from "../../../lib/errors-ui";
import type { Locale } from "../../../lib/i18n";

export function SyncButton({
  projectId,
  locale,
  label,
  busyLabel,
}: {
  projectId: string;
  locale: Locale;
  label: string;
  busyLabel: string;
}) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sync() {
    setBusy(true);
    setMessage(null);
    // The project on screen, not whichever one the server would default to.
    const result = await callApi(`/api/opportunities/sync?projectId=${encodeURIComponent(projectId)}`, {
      method: "POST",
    });
    setBusy(false);
    if (!result.ok) {
      setMessage(apiErrorMessage(locale, result.failure));
      return;
    }
    startTransition(() => router.refresh());
  }

  const working = busy || refreshing;
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {message && (
        <span className="pill warn" role="status" style={{ whiteSpace: "normal" }}>
          <Icon name="alert" />
          {message}
        </span>
      )}
      <button className="btn ghost" onClick={sync} disabled={working}>
        <Icon name="link" />
        {working ? busyLabel : label}
      </button>
    </span>
  );
}
