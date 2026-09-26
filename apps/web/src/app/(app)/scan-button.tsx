"use client";

/**
 * Starts a scan and reflects what the server said.
 *
 * A fresh idempotency key is generated per click, so a double-click cannot queue
 * two crawls, and a refusal is shown as its real reason (a scan is already
 * running, the address is private, …) in the reader's language.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Icon } from "../../components/icons";
import { apiErrorMessage, callApi } from "../../lib/errors-ui";
import type { Locale } from "../../lib/i18n";

export function ScanButton({
  projectId,
  locale,
  label,
  activeLabel,
}: {
  projectId: string;
  locale: Locale;
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
    const result = await callApi(`/api/projects/${projectId}/scans`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: { trigger: "MANUAL" },
    });
    setBusy(false);
    if (!result.ok) {
      setMessage(apiErrorMessage(locale, result.failure));
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {message && (
        <span className="pill warn" role="status" style={{ whiteSpace: "normal" }}>
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
