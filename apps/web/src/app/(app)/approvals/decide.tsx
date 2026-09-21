"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "../../../components/icons";

export function DecideButtons({
  id,
  disabled,
  labels,
}: {
  id: string;
  disabled: boolean;
  labels: { approve: string; reject: string; forbidden: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/approvals/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
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
        <span className="pill warn" role="status">
          <Icon name="alert" />
          {error}
        </span>
      )}
      <button className="btn danger sm" onClick={() => decide("reject")} disabled={busy}>
        <Icon name="x" />
        {labels.reject}
      </button>
      <button className="btn primary sm" onClick={() => decide("approve")} disabled={busy}>
        <Icon name="check" />
        {labels.approve}
      </button>
    </span>
  );
}
