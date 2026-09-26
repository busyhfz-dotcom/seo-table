"use client";

/**
 * Pieces every Instagram / Telegram screen shares: the account's shape as the
 * API returns it, platform-specific wording, source and status pills, the
 * profile header, and "sync now" with its wait for the result.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, kindIcon } from "../../../components/icons";
import { Rich, UserText } from "../../../components/ui";
import { callApi, apiErrorMessage } from "../../../lib/errors-ui";
import { fmt } from "../../../lib/dict";
import { num } from "../../../lib/format";
import { localized } from "../../../lib/seo-labels";
import type { Locale } from "../../../lib/i18n";
import type { SocialStrings } from "./strings";

export type Platform = "INSTAGRAM" | "TELEGRAM";

export type SocialCtx = {
  projectId: string;
  platform: Platform;
  locale: Locale;
  /** Reason code → sentence in the reader's language. */
  reasons: Record<string, string>;
  links: Record<"overview" | "audit" | "analytics" | "posts" | "planner" | "competitors" | "fixes" | "approvals", string>;
  can: { write: boolean; connect: boolean; check: boolean; approve: boolean };
};

export type Account = {
  platform: Platform;
  status: "CONNECTED" | "NOT_CONNECTED" | "ERROR";
  connected: boolean;
  externalId: string | null;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  website: string | null;
  followers: number | null;
  following: number | null;
  mediaCount: number | null;
  profile: {
    pictureUrl?: string | null;
    accountType?: string | null;
    botUsername?: string | null;
    rights?: Record<string, boolean>;
    pinnedMessageId?: number | null;
    updates?: { mode: "webhook" | "polling"; error?: string | null };
    publicPreview?: boolean;
    businessDiscovery?: boolean | null;
  };
  settings: { keywords?: string[]; cta?: string | null; link?: string | null; timezone?: string | null };
  scopes: string[];
  tokenExpiresAt: string | null;
  lastError: string | null;
  lastSyncAt: string | null;
  connectedAt: string | null;
};

export type SocialStatus = {
  platform: Platform;
  account: Account;
  instagramConfigured: boolean | null;
  capabilities: {
    editProfile: boolean;
    publish: string[];
    editPosts: boolean;
    pin: boolean;
    competitors: boolean | null;
    views?: boolean | null;
    notes: string[];
  };
};

export const DEFAULT_TZ = "Asia/Tehran";

/** The _IG or _TG variant of a key. */
export function pk<K extends string>(s: SocialStrings, key: K, platform: Platform): string {
  return (s as Record<string, string>)[`${key}_${platform === "INSTAGRAM" ? "IG" : "TG"}`] ?? key;
}

/** A key that may be missing (a code from the server): its wording, or null. */
export function maybe(s: SocialStrings, key: string): string | null {
  return (s as Record<string, string>)[key] ?? null;
}

/** A platform reason code in the reader's language; rights are named, never shown as code. */
export function reasonOf(ctx: Pick<SocialCtx, "reasons">, s: SocialStrings, code: string | null | undefined): string {
  if (!code) return s.unknown_reason;
  if (ctx.reasons[code]) return ctx.reasons[code]!;
  if (code.startsWith("missing_right:")) {
    const right = maybe(s, `right_${code.slice("missing_right:".length)}`);
    if (right) return `${s.tg_missing} ${right}`;
  }
  return s.unknown_reason;
}

export function PlatformIcon({ platform }: { platform: Platform }) {
  return <Icon name={kindIcon(platform)} />;
}

export function AccountPill({ status, s }: { status: Account["status"]; s: SocialStrings }) {
  const tone = status === "CONNECTED" ? "ok" : status === "ERROR" ? "crit" : "mute";
  const icon = status === "CONNECTED" ? "check" : status === "ERROR" ? "alert" : "x";
  return (
    <span className={`pill ${tone}`}>
      <Icon name={icon} />
      {s[`st_${status}`]}
    </span>
  );
}

export type SocialSource = "api" | "public_preview" | "business_discovery";

/** Where a number came from, with the reason it can be trusted as a tooltip. */
export function SourcePill({ source, platform, s }: { source: SocialSource | null | undefined; platform: Platform; s: SocialStrings }) {
  if (!source) return null;
  const label = source === "api" ? pk(s, "src_api", platform) : source === "public_preview" ? s.src_public_preview : s.src_business_discovery;
  const help = source === "api" ? pk(s, "src_help_api", platform) : source === "public_preview" ? s.src_help_public_preview : undefined;
  return (
    <span className={`pill src ${source === "api" ? "info" : "mute"}`} title={help}>
      {label}
    </span>
  );
}

const SEV_TONE: Record<string, string> = { CRITICAL: "crit", SERIOUS: "serious", WARNING: "warn", INFO: "info" };

export function SevPill({ severity, s }: { severity: string; s: SocialStrings }) {
  return (
    <span className={`sev ${SEV_TONE[severity] ?? "info"}`}>
      <i />
      <span>{maybe(s, `sev_${severity}`) ?? severity}</span>
    </span>
  );
}

export function profileHref(account: Pick<Account, "platform" | "username">): string | null {
  if (!account.username) return null;
  return account.platform === "INSTAGRAM" ? `https://www.instagram.com/${account.username}/` : `https://t.me/${account.username}`;
}

/** Initials instead of the profile picture: the panel loads no third-party images. */
export function Avatar({ name, platform, size = 56 }: { name: string | null; platform: Platform; size?: number }) {
  const letters = (name ?? "").trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] ?? "").join("");
  return (
    <span className={`avatar ${platform === "INSTAGRAM" ? "ig" : "tg"}`} style={{ width: size, height: size }} aria-hidden="true">
      {letters ? <span translate="no">{letters}</span> : <PlatformIcon platform={platform} />}
    </span>
  );
}

export function ProfileHeader({ account, s, locale, children }: { account: Account; s: SocialStrings; locale: Locale; children?: React.ReactNode }) {
  const href = profileHref(account);
  const count = account.followers;
  return (
    <div className="profile-head">
      <Avatar name={account.displayName ?? account.username} platform={account.platform} />
      <div className="profile-id">
        <div className="row" style={{ gap: 8 }}>
          <b className="profile-name">
            <UserText>{account.displayName ?? account.username ?? pk(s, "page", account.platform)}</UserText>
          </b>
          <AccountPill status={account.status} s={s} />
        </div>
        <div className="row small muted" style={{ gap: 10 }}>
          {account.username && (
            <span dir="ltr" translate="no">
              @{account.username}
            </span>
          )}
          {count !== null && (
            <span>
              {num(count, locale)} {pk(s, "followers", account.platform)}
            </span>
          )}
          {href && (
            <a href={href} target="_blank" rel="noreferrer noopener" className="lnk">
              <Icon name="external" />
              {pk(s, "open_on_platform", account.platform)}
            </a>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * "Sync now": queue a sync, then watch GET /social until the account's
 * lastSyncAt moves (the sync writes it when it is done) or an error appears.
 */
export function useSync(ctx: SocialCtx, s: SocialStrings, onDone: (status: SocialStatus | null, error: string | null) => void) {
  const [state, setState] = useState<"idle" | "queued" | "slow">("idle");
  const [error, setError] = useState<string | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const stop = useRef(false);
  useEffect(
    () => () => {
      stop.current = true;
    },
    [],
  );

  const watch = useCallback(
    async (before: string | null) => {
      setState("queued");
      const started = Date.now();
      stop.current = false;
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500));
        if (stop.current) return;
        const r = await callApi<SocialStatus>(`/api/projects/${encodeURIComponent(ctx.projectId)}/social`);
        if (r.ok && r.data.account.lastSyncAt && r.data.account.lastSyncAt !== before) {
          setState("idle");
          done.current(r.data, null);
          return;
        }
        if (r.ok && r.data.account.status === "ERROR" && r.data.account.lastError) {
          setState("idle");
          done.current(r.data, reasonOf(ctx, s, r.data.account.lastError));
          return;
        }
        if (Date.now() - started > 180_000) {
          setState("slow");
          return;
        }
      }
    },
    [ctx, s],
  );

  const start = useCallback(
    async (before: string | null) => {
      setError(null);
      const r = await callApi<{ jobId: string }>(`/api/projects/${encodeURIComponent(ctx.projectId)}/social/sync`, { method: "POST" });
      if (!r.ok) {
        setError(apiErrorMessage(ctx.locale, r.failure));
        return;
      }
      await watch(before);
    },
    [ctx, watch],
  );

  return { state, error, start, watch };
}

/** A sentence with `code` spans and {slots}. */
export function RichFmt({ text, vars }: { text: string; vars?: Record<string, string | number> }) {
  return <Rich text={vars ? fmt(text, vars) : text} />;
}

/** A value that is already a percentage (12.3 → "12.3%" / "۱۲٫۳٪"). */
export function percent(value: number | null | undefined, locale: Locale, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const n = value.toLocaleString(locale === "fa" ? "fa-IR" : "en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return locale === "fa" ? `${n}٪` : `${n}%`;
}

/** A signed whole number ("+12" / "‎+۱۲"), for changes. */
export function signed(value: number, locale: Locale): string {
  const n = num(Math.abs(value), locale);
  return value > 0 ? `+${n}` : value < 0 ? `−${n}` : n;
}

export const TIMEZONES = ["Asia/Tehran", "Asia/Dubai", "Europe/Istanbul", "Europe/London", "Europe/Berlin", "America/New_York", "America/Toronto", "UTC"];

export function tzLabel(tz: string, s: SocialStrings): string {
  return maybe(s, `tz_${tz.replace(/\//g, "_")}`) ?? tz;
}

/**
 * A sentence the server worded (an audit detail): the profile's own values
 * inside «…» or “…” are the owner's text, and a time zone id is named.
 */
export function ServerText({ pair, locale, s }: { pair: { fa: string; en: string }; locale: Locale; s: SocialStrings }) {
  const text = localized(pair, locale);
  const parts = text.split(/(«[^»]*»|“[^”]*”|\b[A-Z][A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b)/);
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return p;
        if (p.startsWith("«") || p.startsWith("“")) {
          return (
            <span key={i}>
              {p[0]}
              <UserText>{p.slice(1, -1)}</UserText>
              {p[p.length - 1]}
            </span>
          );
        }
        return TIMEZONES.includes(p) ? (
          <span key={i}>{tzLabel(p, s)}</span>
        ) : (
          <span key={i} translate="no" dir="ltr">
            {p}
          </span>
        );
      })}
    </>
  );
}
