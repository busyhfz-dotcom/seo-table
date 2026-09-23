"use client";

/**
 * Small pieces every connect screen shares: the context the method cards read,
 * status pills, the owner-permission checkbox, inline confirmation, and the
 * result line an action leaves behind.
 */
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useId, useState, useTransition, type ReactNode } from "react";
import { Icon } from "../../../components/icons";
import { Rich } from "../../../components/ui";
import { num, toPersianDigits } from "../../../lib/format";
import { fill, type Locale } from "../../../lib/i18n";
import type { ConnectStrings } from "./keys";
import type { MethodStatus } from "./load";

export type ConnectContext = {
  s: ConnectStrings;
  locale: Locale;
  projectId: string;
  baseUrl: string;
  /** connector:write — connect, install, disconnect, choose the write target. */
  canWrite: boolean;
  /** scan:run — re-detect the platform, inspect URLs. */
  canRun: boolean;
};

const Ctx = createContext<ConnectContext | null>(null);

export function ConnectProvider({ value, children }: { value: ConnectContext; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useConnect(): ConnectContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useConnect outside ConnectProvider");
  return ctx;
}

/** Re-render the server parts after a change, and say while it is happening. */
export function useRefresh(): [boolean, () => void] {
  const router = useRouter();
  const [pending, start] = useTransition();
  const refresh = useCallback(() => start(() => router.refresh()), [router]);
  return [pending, refresh];
}

export type Msg = { tone: "ok" | "crit" | "info"; text: string; list?: string[] };

export function Message({ msg }: { msg: Msg | null }) {
  if (!msg) return null;
  const tone = msg.tone === "ok" ? " acc" : msg.tone === "crit" ? " crit" : "";
  return (
    <div className={`note${tone}`} role={msg.tone === "crit" ? "alert" : "status"}>
      <Icon name={msg.tone === "ok" ? "check" : msg.tone === "crit" ? "alert" : "info"} />
      <div>
        <Rich text={msg.text} />
        {msg.list && msg.list.length > 0 && (
          <ul className="plain" style={{ marginTop: 6 }}>
            {msg.list.map((n, i) => (
              <li key={i}>
                <Rich text={n} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const STATUS_TONE: Record<MethodStatus, { tone: string; icon: string }> = {
  connected: { tone: "ok", icon: "check" },
  needs_install: { tone: "warn", icon: "alert" },
  not_installed: { tone: "warn", icon: "puzzle" },
  not_connected: { tone: "mute", icon: "x" },
  error: { tone: "crit", icon: "alert" },
  not_applicable: { tone: "mute", icon: "info" },
  available: { tone: "info", icon: "doc" },
};

export function MethodStatusPill({ status }: { status: MethodStatus }) {
  const { s } = useConnect();
  const spec = STATUS_TONE[status];
  return (
    <span className={`pill ${spec.tone}`}>
      <Icon name={spec.icon} />
      {s[`ms_${status}`]}
    </span>
  );
}

/** Writable field ids (connector capabilities) as the reader's words. */
const FIELD_ORDER = ["title", "meta_description", "canonical", "meta_robots", "img.alt", "jsonld", "hreflang", "redirect"];

export function FieldList({ fields }: { fields: string[] }) {
  const { s } = useConnect();
  const known = FIELD_ORDER.filter((f) => fields.includes(f));
  return (
    <ul className="fieldlist">
      {known.map((f) => (
        <li key={f}>
          <Icon name="check" />
          {s[`f_${f.replace(".", "_")}` as keyof ConnectStrings]}
        </li>
      ))}
    </ul>
  );
}

/**
 * The owner's permission, asked for right where a change to the site is about
 * to be connected or installed — not once in a settings screen.
 */
export function Consent({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const { s } = useConnect();
  const id = useId();
  return (
    <label className="consent" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{s.cn_consent}</span>
    </label>
  );
}

/** A destructive action that asks once more, inline, before it runs. */
export function ConfirmButton({
  label,
  question,
  onConfirm,
  disabled,
  icon = "x",
}: {
  label: string;
  question: string;
  onConfirm: () => void;
  disabled?: boolean;
  icon?: string;
}) {
  const { s } = useConnect();
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className="btn ghost" onClick={() => setAsking(true)} disabled={disabled}>
        <Icon name={icon} />
        {label}
      </button>
    );
  }
  return (
    <div className="confirm" role="group" aria-label={label}>
      <p>{question}</p>
      <div className="row">
        <button
          type="button"
          className="btn danger"
          onClick={() => {
            setAsking(false);
            onConfirm();
          }}
          disabled={disabled}
        >
          <Icon name={icon} />
          {label}
        </button>
        <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
          {s.cancel}
        </button>
      </div>
    </div>
  );
}

export function Spinner() {
  return <span className="spin" aria-hidden="true" />;
}

/** "12 KB" / "۱۲ کیلوبایت". */
export function useSize() {
  const { s, locale } = useConnect();
  return (bytes: number) =>
    bytes < 1024 ? fill(s.bytes, { n: num(bytes, locale) }) : fill(s.kilobytes, { n: num(Math.ceil(bytes / 1024), locale) });
}

/** Version strings and the like, in the reader's digits. */
export function digits(value: string, locale: Locale): string {
  return locale === "fa" ? toPersianDigits(value).replaceAll(".", "٫") : value;
}
