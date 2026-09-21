"use client";

/**
 * The buttons a fix can offer.
 *
 * What is shown here mirrors the server's policy, it does not define it: a fix
 * that needs approval gets no Apply button, and if one were forged the route,
 * the executor and a database trigger would each refuse it in turn.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "../../../components/icons";

export function FixActions({
  id,
  status,
  needsApproval,
  approved,
  hasDryRun,
  canApply,
  labels,
}: {
  id: string;
  status: string;
  needsApproval: boolean;
  approved: boolean;
  hasDryRun: boolean;
  canApply: boolean;
  labels: { dryRun: string; apply: string; rollback: string; waiting: string; forbidden: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  async function call(path: string, action: string) {
    setBusy(action);
    setMessage(null);
    try {
      const res = await fetch(`/api/fixes/${id}/${path}`, { method: "POST" });
      const data = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        setMessage({ tone: "warn", text: data.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      setMessage({ tone: "ok", text: "…" });
      // The work runs on the worker, so refresh rather than pretending it is done.
      setTimeout(() => router.refresh(), 1200);
    } catch (err) {
      setMessage({ tone: "warn", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const applied = status === "APPLIED";
  const canApplyNow = canApply && (!needsApproval || approved) && hasDryRun && !applied;

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      {!applied && (
        <button className="btn ghost" onClick={() => call("dry-run", "dry")} disabled={busy !== null}>
          <Icon name="eye" />
          {labels.dryRun}
        </button>
      )}

      {canApplyNow && (
        <button className="btn primary" onClick={() => call("apply", "apply")} disabled={busy !== null}>
          <Icon name="play" />
          {labels.apply}
        </button>
      )}

      {!applied && needsApproval && !approved && (
        <span className="pill warn">
          <Icon name="lock" />
          {labels.waiting}
        </span>
      )}

      {!applied && !needsApproval && !hasDryRun && (
        <span className="pill mute">
          <Icon name="info" />
          {labels.dryRun}
        </span>
      )}

      {!canApply && !applied && (
        <span className="pill mute">
          <Icon name="lock" />
          {labels.forbidden}
        </span>
      )}

      {applied && (
        <button className="btn ghost" onClick={() => call("rollback", "rollback")} disabled={busy !== null}>
          <Icon name="undo" />
          {labels.rollback}
        </button>
      )}

      {message && (
        <span className={`pill ${message.tone}`} role="status">
          <Icon name={message.tone === "ok" ? "check" : "alert"} />
          {message.text}
        </span>
      )}
    </div>
  );
}
