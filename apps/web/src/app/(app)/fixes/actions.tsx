"use client";

/**
 * The buttons a fix can offer.
 *
 * What is shown here mirrors the server's policy and the reader's permissions,
 * it does not define them: a fix that needs approval gets no Apply button, and
 * if one were forged the route, the executor and a database trigger would each
 * refuse it in turn.
 *
 * Dry runs and applies run on the worker, so after queuing one the screen
 * refreshes until the server reports the outcome (a new dry-run timestamp, or a
 * status other than APPLYING) instead of pretending it finished. A rollback runs
 * in the request and its per-change outcome is shown right here.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Icon } from "../../../components/icons";
import { apiErrorMessage, callApi } from "../../../lib/errors-ui";
import { num, pathOf } from "../../../lib/format";
import type { Locale } from "../../../lib/i18n";
import { readableUrl, resultCodeLabel } from "../../../lib/labels";

type Labels = {
  dryRun: string;
  apply: string;
  retry: string;
  rollback: string;
  waiting: string;
  forbidden: string;
  dryRunFirst: string;
  queued: string;
  slow: string;
  rolledBack: string;
  rollbackPartial: string;
};

type WriteResult = { url: string; field: string; ok: boolean; code?: string };
type Waiting = { kind: "dry"; since: string | null } | { kind: "apply"; since: string };

const POLL_MS = 1500;
const POLL_LIMIT_MS = 45_000;

const CONFLICT = {
  fa: "این اصلاح در وضعیت فعلی قابل انجام نیست؛ شاید همین حالا در حال اجراست. صفحه را بازآوری کن.",
  en: "This fix cannot do that in its current state; it may be running right now. Refresh the page.",
};

export function FixActions({
  id,
  status,
  needsApproval,
  approved,
  dryRunAt,
  canRollback,
  perms,
  locale,
  labels,
}: {
  id: string;
  status: string;
  needsApproval: boolean;
  approved: boolean;
  /** When the last dry run finished (ISO), or null if none has. */
  dryRunAt: string | null;
  /** The latest live execution still has writes on the site to undo. */
  canRollback: boolean;
  perms: { propose: boolean; apply: boolean; rollback: boolean };
  locale: Locale;
  labels: Labels;
}) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [slow, setSlow] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "warn"; text: string; details?: string[] } | null>(null);

  // Settled once the server shows the outcome of what was queued.
  const settled =
    waiting !== null &&
    (waiting.kind === "dry" ? dryRunAt !== waiting.since : status !== waiting.since && status !== "APPLYING");

  useEffect(() => {
    if (!waiting || settled) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > POLL_LIMIT_MS) {
        clearInterval(timer);
        setSlow(true);
        return;
      }
      startTransition(() => router.refresh());
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, settled, router]);

  const inFlight = busy || refreshing || (waiting !== null && !settled && !slow);

  async function queue(path: "dry-run" | "apply") {
    setBusy(true);
    setMessage(null);
    setSlow(false);
    const result = await callApi(`/api/fixes/${id}/${path}`, { method: "POST" });
    setBusy(false);
    if (!result.ok) {
      setMessage({ tone: "warn", text: apiErrorMessage(locale, result.failure, { CONFLICT }) });
      return;
    }
    setWaiting(path === "dry-run" ? { kind: "dry", since: dryRunAt } : { kind: "apply", since: status });
    startTransition(() => router.refresh());
  }

  async function rollback() {
    setBusy(true);
    setMessage(null);
    const result = await callApi<{ status: string; applied: number; failed: number; results: WriteResult[] }>(
      `/api/fixes/${id}/rollback`,
      { method: "POST" },
    );
    setBusy(false);
    if (!result.ok) {
      setMessage({ tone: "warn", text: apiErrorMessage(locale, result.failure, { CONFLICT }) });
      return;
    }
    const { applied, failed, results } = result.data;
    const total = num(applied + failed, locale);
    setMessage({
      tone: failed === 0 ? "ok" : "warn",
      text: (failed === 0 ? labels.rolledBack : labels.rollbackPartial)
        .replace("{n}", num(applied, locale))
        .replace("{m}", total),
      details: results
        .filter((r) => !r.ok)
        .slice(0, 5)
        .map((r) => `${readableUrl(pathOf(r.url))} — ${resultCodeLabel(r.code, r.ok, locale)}`),
    });
    startTransition(() => router.refresh());
  }

  const runnable = status === "DRAFT" || status === "APPROVED" || status === "FAILED";
  const approvalMissing = needsApproval && !approved;
  const showDryRun = runnable && perms.propose;
  const showApply = runnable && perms.apply && !approvalMissing && dryRunAt !== null;
  const showRollback = canRollback && perms.rollback;
  const nothingAllowed = !showDryRun && !showApply && !showRollback;

  const pending = waiting !== null && !settled;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {showDryRun && (
          <button className="btn ghost" onClick={() => queue("dry-run")} disabled={inFlight}>
            <Icon name="eye" />
            {labels.dryRun}
          </button>
        )}

        {showApply && (
          <button className="btn primary" onClick={() => queue("apply")} disabled={inFlight}>
            <Icon name="play" />
            {status === "FAILED" ? labels.retry : labels.apply}
          </button>
        )}

        {showRollback && (
          <button className="btn ghost" onClick={rollback} disabled={inFlight}>
            <Icon name="undo" />
            {labels.rollback}
          </button>
        )}

        {runnable && approvalMissing && (
          <span className="pill warn">
            <Icon name="lock" />
            {labels.waiting}
          </span>
        )}

        {runnable && !approvalMissing && perms.apply && dryRunAt === null && (
          <span className="pill mute">
            <Icon name="info" />
            {labels.dryRunFirst}
          </span>
        )}

        {nothingAllowed && (runnable || canRollback) && (
          <span className="pill mute">
            <Icon name="lock" />
            {labels.forbidden}
          </span>
        )}
      </div>

      {pending && (
        <span className="pill info" role="status" style={{ alignSelf: "flex-start", whiteSpace: "normal" }}>
          <Icon name="clock" />
          {slow ? labels.slow : labels.queued}
        </span>
      )}

      {message && (
        <div className={`note ${message.tone === "ok" ? "acc" : "crit"}`} role="status">
          <Icon name={message.tone === "ok" ? "check" : "alert"} />
          <div>
            {message.text}
            {message.details && message.details.length > 0 && (
              <ul className="plain" style={{ marginTop: 4 }}>
                {message.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
