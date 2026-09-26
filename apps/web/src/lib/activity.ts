/**
 * Audit-log entries as sentences, for the dashboard feed and the audit-log tab.
 * Every action string passed to `recordAudit` anywhere in the codebase has a
 * case here; anything new falls back to the raw action rather than vanishing.
 */
import type { Locale } from "./i18n";
import { num } from "./format";
import { actionLabel, connectorLabel } from "./labels";
import { describeConnectionAction } from "./connector-messages";
import { describeSeoDataAction } from "./seo-data-activity";

export function iconForAction(action: string): string {
  if (action.startsWith("scan")) return action.includes("refused") ? "x" : "play";
  if (action === "fix.rollback") return "undo";
  if (action.startsWith("fix")) return "wand";
  if (action.startsWith("approval")) return "shield";
  if (action.startsWith("connector")) return "plug";
  if (action.startsWith("auth")) return "user";
  if (action.startsWith("apikey")) return "key";
  if (action.startsWith("project")) return "folder";
  if (action.startsWith("social.post")) return action === "social.post_failed" ? "alert" : "calendar";
  if (action.startsWith("social.competitor")) return "users";
  if (action === "social.audit") return "pulse";
  if (action === "social.sync") return "refresh";
  if (action.startsWith("social.")) return action.includes("failed") ? "alert" : "plug";
  return "info";
}

export function describeAction(action: string, actorType: string, metadata: unknown, locale: Locale): string {
  const m = (metadata ?? {}) as Record<string, unknown>;
  const act = actionLabel(String(m.action ?? ""), locale);
  const n = (v: unknown) => num(Number(v ?? 0), locale);
  const kind = connectorLabel(String(m.kind ?? ""));
  const fa = locale === "fa";
  const auto = actorType === "AGENT";

  switch (action) {
    case "scan.enqueue":
      return fa ? "اسکن در صف قرار گرفت" : "Scan queued";
    case "scan.refused_overlap":
      return fa ? "اسکن رد شد: اسکن دیگری در حال اجراست" : "Scan refused: another is already running";
    case "scan.cancel":
      return fa ? "اسکن لغو شد" : "Scan cancelled";
    case "fix.propose":
      return fa
        ? `پیشنهاد اصلاح: ${act} روی ${n(m.targetCount)} هدف`
        : `Fix proposed: ${act} on ${n(m.targetCount)} targets`;
    case "fix.dry_run":
      return fa
        ? `اجرای آزمایشی ${act}: ${n(m.applied)} تغییر آماده${Number(m.failed) > 0 ? `، ${n(m.failed)} ناموفق` : ""}`
        : `Dry run of ${act}: ${n(m.applied)} ready${Number(m.failed) > 0 ? `, ${n(m.failed)} failed` : ""}`;
    case "fix.apply": {
      const failed = Number(m.failed) > 0;
      if (fa) {
        return `${act}: ${n(m.applied)} تغییر اعمال شد${failed ? `، ${n(m.failed)} ناموفق` : ""}${auto ? " (خودکار، کم‌ریسک)" : ""}`;
      }
      return `${act}: ${n(m.applied)} changes applied${failed ? `, ${n(m.failed)} failed` : ""}${auto ? " (automatic, low risk)" : ""}`;
    }
    case "fix.apply_blocked":
      return fa ? `اعمال ${act} مسدود شد (نیازمند تأیید)` : `${act} blocked (approval required)`;
    case "fix.rollback":
      if (m.complete === false) {
        return fa
          ? `بازگردانی ناقص: ${n(m.restored)} از ${n(m.of)} تغییر`
          : `Partial rollback: ${n(m.restored)} of ${n(m.of)} changes`;
      }
      return fa ? `${n(m.restored)} تغییر بازگردانده شد` : `${n(m.restored)} changes rolled back`;
    case "approval.request":
      return fa ? `ارسال برای تأیید: ${act}` : `Sent for approval: ${act}`;
    case "approval.approve":
      return fa ? `تأیید شد: ${act}` : `Approved: ${act}`;
    case "approval.reject":
      return fa ? `رد شد: ${act}` : `Rejected: ${act}`;
    case "connector.connect":
      if (m.ok) return fa ? `${kind} متصل شد` : `${kind} connected`;
      return fa ? `اتصال ${kind} ناموفق بود` : `${kind} connection failed`;
    case "connector.disconnect":
      return fa ? `اتصال ${kind} قطع شد` : `${kind} disconnected`;
    case "connector.sync":
      return fa ? `${n(m.rows)} ردیف از Search Console همگام شد` : `${n(m.rows)} rows synced from Search Console`;
    case "project.create":
      return fa ? "پروژه ساخته شد" : "Project created";
    case "auth.login":
      return fa ? "ورود به حساب" : "Signed in";
    case "auth.login_failed":
      return fa ? "تلاش ناموفق برای ورود" : "Failed sign-in attempt";
    case "auth.logout":
      return fa ? "خروج از حساب" : "Signed out";
    case "auth.org_switch":
      return fa ? "تغییر سازمان فعال" : "Switched organization";
    case "apikey.create":
      return fa ? "کلید API ساخته شد" : "API key created";
    case "apikey.revoke":
      return fa ? "کلید API لغو شد" : "API key revoked";
    default:
      return describeConnectionAction(action, m, locale) ?? describeSeoDataAction(action, m, locale) ?? action;
  }
}
