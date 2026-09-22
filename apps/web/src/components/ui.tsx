/**
 * Shared presentation pieces. Status and severity always carry an icon or a bar
 * alongside their colour, so nothing in the interface is encoded by hue alone.
 */
import type { ReactNode } from "react";
import { readableUrl } from "../lib/labels";
import { Icon } from "./icons";
import type { T } from "../lib/i18n";

export function Card({
  title,
  sub,
  right,
  children,
  bare,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  bare?: boolean;
}) {
  return (
    <section className="card">
      {(title || right) && (
        <header>
          {title && <h3>{title}</h3>}
          {sub && <span className="sub">{sub}</span>}
          <span className="spacer" />
          {right}
        </header>
      )}
      {bare ? children : <div className="body">{children}</div>}
    </section>
  );
}

export function Tile({
  label,
  value,
  foot,
  suffix,
}: {
  label: string;
  value: ReactNode;
  foot?: ReactNode;
  suffix?: ReactNode;
}) {
  return (
    <div className="card tile">
      <div className="k">{label}</div>
      <div className="v">
        {value}
        {suffix}
      </div>
      {foot && <div className="foot">{foot}</div>}
    </div>
  );
}

const SEVERITY_TONE = {
  CRITICAL: "crit",
  SERIOUS: "serious",
  WARNING: "warn",
  INFO: "info",
} as const;

export function Sev({ severity, t }: { severity: keyof typeof SEVERITY_TONE; t: T }) {
  const label = {
    CRITICAL: t("sev_critical"),
    SERIOUS: t("sev_serious"),
    WARNING: t("sev_warning"),
    INFO: t("sev_info"),
  }[severity];
  return (
    <span className={`sev ${SEVERITY_TONE[severity]}`}>
      <i />
      <span>{label}</span>
    </span>
  );
}

type StatusKey =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED"
  | "DEAD_LETTER"
  | "OPEN"
  | "FIXED"
  | "IGNORED"
  | "DRAFT"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "APPLYING"
  | "APPLIED"
  | "ROLLED_BACK"
  | "CONNECTED"
  | "NOT_CONNECTED"
  | "ERROR";

const STATUS: Record<StatusKey, { tone: string; icon: string; key: string }> = {
  QUEUED: { tone: "mute", icon: "clock", key: "st_queued" },
  RUNNING: { tone: "info", icon: "play", key: "st_running" },
  SUCCEEDED: { tone: "ok", icon: "check", key: "st_succeeded" },
  FAILED: { tone: "crit", icon: "x", key: "st_failed" },
  CANCELED: { tone: "mute", icon: "x", key: "st_canceled" },
  DEAD_LETTER: { tone: "crit", icon: "alert", key: "st_dead_letter" },
  OPEN: { tone: "serious", icon: "alert", key: "st_open" },
  FIXED: { tone: "ok", icon: "check", key: "st_fixed" },
  IGNORED: { tone: "mute", icon: "eye", key: "st_ignored" },
  DRAFT: { tone: "mute", icon: "doc", key: "st_draft" },
  AWAITING_APPROVAL: { tone: "warn", icon: "lock", key: "st_awaiting_approval" },
  APPROVED: { tone: "ok", icon: "check", key: "st_approved" },
  REJECTED: { tone: "crit", icon: "x", key: "st_rejected" },
  APPLYING: { tone: "info", icon: "play", key: "st_applying" },
  APPLIED: { tone: "ok", icon: "check", key: "st_applied" },
  ROLLED_BACK: { tone: "mute", icon: "undo", key: "st_rolled_back" },
  CONNECTED: { tone: "ok", icon: "check", key: "st_connected" },
  NOT_CONNECTED: { tone: "mute", icon: "x", key: "st_not_connected" },
  ERROR: { tone: "crit", icon: "alert", key: "st_error" },
};

export function Status({ value, t }: { value: string; t: T }) {
  const spec = STATUS[value as StatusKey] ?? STATUS.DRAFT;
  return (
    <span className={`pill ${spec.tone}`}>
      <Icon name={spec.icon} />
      {t(spec.key as never)}
    </span>
  );
}

export function RiskPill({ risk, t }: { risk: "LOW" | "SENSITIVE" | "RESTRICTED"; t: T }) {
  if (risk === "LOW") {
    return (
      <span className="pill ok">
        <Icon name="check" />
        {t("risk_low")}
      </span>
    );
  }
  if (risk === "SENSITIVE") {
    return (
      <span className="pill warn">
        <Icon name="alert" />
        {t("risk_sensitive")}
      </span>
    );
  }
  return (
    <span className="pill crit">
      <Icon name="lock" />
      {t("risk_restricted")}
    </span>
  );
}

export function Note({
  tone = "plain",
  icon = "info",
  children,
}: {
  tone?: "plain" | "lock" | "acc" | "crit";
  icon?: string;
  children: ReactNode;
}) {
  return (
    <div className={`note${tone === "plain" ? "" : ` ${tone}`}`}>
      <Icon name={icon} />
      <div>{children}</div>
    </div>
  );
}

export function Empty({ children, icon = "box" }: { children: ReactNode; icon?: string }) {
  return (
    <div className="empty">
      <Icon name={icon} />
      <div>{children}</div>
    </div>
  );
}

/**
 * Before/after of one change. Each line takes its direction from its own text
 * (a Persian title reads right-to-left, a URL left-to-right), and only URLs use
 * the monospace face.
 */
export function Diff({ before, after }: { before: string | null; after: string | null }) {
  const line = (value: string | null) => {
    const text = readableUrl(value) ?? "∅";
    return (
      <span dir="auto" className={looksLikeUrl(text) ? "url" : undefined}>
        {text}
      </span>
    );
  };
  return (
    <div className="diff">
      {before !== null && (
        <div className="del">
          <em>−</em>
          {line(before)}
        </div>
      )}
      <div className="add">
        <em>+</em>
        {line(after)}
      </div>
    </div>
  );
}

function looksLikeUrl(value: string): boolean {
  return /^(https?:\/\/|\/)\S*$/.test(value.trim());
}

export function Bar({ value, max, tone }: { value: number; max: number; tone?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="bar">
      <i style={{ width: `${pct}%`, ...(tone ? { background: `var(--${tone})` } : {}) }} />
    </div>
  );
}

export function Table({
  head,
  children,
}: {
  head: Array<{ label: ReactNode; numeric?: boolean }>;
  children: ReactNode;
}) {
  return (
    <div className="tw">
      <table>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} style={h.numeric ? { textAlign: "end" } : undefined}>
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
