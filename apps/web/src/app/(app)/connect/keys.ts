import { MESSAGE_KEYS, type MessageKey, type T } from "../../../lib/i18n";

/**
 * The strings the connect screens' client components need (connect site,
 * onboarding, Search Console tools, fix previews), translated on the server.
 * Chosen by prefix so a new key in one of these families reaches the client
 * without another list to keep in step; the type follows the same prefixes.
 */
const PREFIXES = ["cn_", "m_", "md_", "ms_", "f_", "cf_", "wp_", "bp_", "fp_", "wt_", "tg_", "sc_", "pv_", "ob_"] as const;
const EXTRA = [
  "close",
  "bytes",
  "kilobytes",
  "site_url",
  "username",
  "app_password",
  "download",
  "loading",
  "cancel",
  "scan",
  "st_running",
  "preview",
  "connect_site",
  "project_name",
  "project_lang",
  "lang_fa",
  "lang_en",
  "page_cap",
  "crawl_rate",
  "page_url",
  "br_open",
  "br_title",
  "br_description",
  "br_canonical",
  "br_robots",
  "br_h1",
  "br_desktop",
  "br_mobile",
  "br_device",
  "br_none",
  "br_unavailable",
  "br_busy",
  "br_blocked",
  "fx_no_target",
] as const satisfies readonly MessageKey[];

export type ConnectKey = Extract<MessageKey, `${(typeof PREFIXES)[number]}${string}`> | (typeof EXTRA)[number];
export type ConnectStrings = Record<ConnectKey, string>;

export function connectStrings(t: T): ConnectStrings {
  const keys = MESSAGE_KEYS.filter(
    (k) => PREFIXES.some((p) => k.startsWith(p)) || (EXTRA as readonly string[]).includes(k),
  );
  return Object.fromEntries(keys.map((k) => [k, t(k)])) as ConnectStrings;
}
