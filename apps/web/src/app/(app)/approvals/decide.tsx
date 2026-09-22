"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Icon } from "../../../components/icons";
import { apiErrorMessage, callApi } from "../../../lib/errors-ui";
import type { Locale } from "../../../lib/i18n";

const CONFLICT = {
  fa: "این درخواست دیگر در انتظار تصمیم نیست. صفحه را بازآوری کن.",
  en: "This request is no longer waiting for a decision. Refresh the page.",
};

export function DecideButtons({
  id,
  disabled,
  locale,
  labels,
}: {
  id: string;
  disabled: boolean;
  locale: Locale;
  labels: { approve: string; reject: string; forbidden: string };
}) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    const result = await callApi(`/api/approvals/${id}`, { method: "POST", body: { decision } });
    setBusy(false);
    if (!result.ok) {
      setError(apiErrorMessage(locale, result.failure, { CONFLICT }));
      return;
    }
    startTransition(() => router.refresh());
  }

  if (disabled) {
    return (
      <span className="pill mute">
        <Icon name="lock" />
        {labels.forbidden}
      </span>
    );
  }

  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {error && (
        <span className="pill warn" role="status" style={{ whiteSpace: "normal" }}>
          <Icon name="alert" />
          {error}
        </span>
      )}
      <button className="btn danger sm" onClick={() => decide("reject")} disabled={busy || refreshing}>
        <Icon name="x" />
        {labels.reject}
      </button>
      <button className="btn primary sm" onClick={() => decide("approve")} disabled={busy || refreshing}>
        <Icon name="check" />
        {labels.approve}
      </button>
    </span>
  );
}
