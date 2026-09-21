"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "../../../components/icons";

export function SyncButton({ label, busyLabel }: { label: string; busyLabel: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sync() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/opportunities/sync", { method: "POST" });
      const data = (await res.json()) as { error?: { message?: string }; synced?: number };
      if (!res.ok) {
        setMessage(data.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      {message && (
        <span className="pill warn" role="status">
          <Icon name="alert" />
          {message}
        </span>
      )}
      <button className="btn ghost" onClick={sync} disabled={busy}>
        <Icon name="link" />
        {busy ? busyLabel : label}
      </button>
    </span>
  );
}
