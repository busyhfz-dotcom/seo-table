/**
 * Persian (RTL) is the default; English (LTR) is fully supported.
 *
 * Both dictionaries are typed against the same key set, so a missing translation
 * is a compile error rather than a key leaking into the interface.
 */
export type Locale = "fa" | "en";

export const LOCALES: Locale[] = ["fa", "en"];
export const DEFAULT_LOCALE: Locale = "fa";

export function dirOf(locale: Locale): "rtl" | "ltr" {
  return locale === "fa" ? "rtl" : "ltr";
}

const fa = {
  product: "SEO Table",
  tagline: "کنسول سئو",
  nav_setup: "راه‌اندازی",
  nav_analyze: "بررسی",
  nav_act: "اقدام",
  nav_system: "سیستم",

  dashboard: "داشبورد",
  onboarding: "راه‌اندازی اولیه",
  projects: "پروژه‌ها",
  audit: "نتایج اسکن",
  issues: "ایشوها",
  fixes: "اصلاح خودکار",
  approvals: "صف تأیید",
  content: "فرصت‌های محتوا",
  connectors: "اتصال‌ها",
  reports: "گزارش‌ها",
  settings: "تنظیمات",

  scan: "اسکن جدید",
  signin: "ورود",
  signout: "خروج",
  email: "ایمیل",
  password: "رمز عبور",
  login_failed: "ایمیل یا رمز عبور درست نیست",

  all: "همه",
  search: "جستجو",
  export: "خروجی",
  details: "جزئیات",
  view: "مشاهده",
  status: "وضعیت",
  severity: "شدت",
  rule: "قاعده",
  category: "دسته",
  pages: "صفحه",
  occurrences: "تکرار",
  first_seen: "اولین مشاهده",
  last_seen: "آخرین مشاهده",
  last_scan: "آخرین اسکن",
  score: "امتیاز",
  risk: "ریسک",
  approve: "تأیید",
  reject: "رد",
  review: "بازبینی",
  apply: "اعمال",
  dry_run: "اجرای آزمایشی",
  rollback: "بازگردانی",
  preview: "پیش‌نمایش",
  loading: "در حال بارگذاری…",
  nothing_here: "چیزی برای نمایش نیست",
  refresh: "بازآوری",

  sev_critical: "بحرانی",
  sev_serious: "جدی",
  sev_warning: "هشدار",
  sev_info: "اطلاعی",

  risk_low: "کم‌ریسک",
  risk_sensitive: "حساس",
  risk_restricted: "نیازمند تأیید",

  st_queued: "در صف",
  st_running: "در حال اجرا",
  st_succeeded: "تمام‌شده",
  st_failed: "ناموفق",
  st_canceled: "لغو‌شده",
  st_dead_letter: "رهاشده",
  st_open: "باز",
  st_fixed: "اصلاح‌شده",
  st_ignored: "نادیده",
  st_draft: "پیش‌نویس",
  st_awaiting_approval: "در انتظار تأیید",
  st_approved: "تأییدشده",
  st_rejected: "رد‌شده",
  st_applying: "در حال اعمال",
  st_applied: "اعمال‌شده",
  st_rolled_back: "بازگردانده‌شده",
  st_connected: "متصل",
  st_not_connected: "متصل نیست",
  st_error: "خطا",

  t_score: "امتیاز سئو",
  t_pages: "صفحات قابل ایندکس",
  t_open: "ایشوهای باز",
  t_pending: "در انتظار تأیید",
  vs_last: "نسبت به اسکن قبل",
  of_crawled: "از {n} صفحه خزش‌شده",
  need_human: "نیازمند تصمیم انسان",
  score_trend: "روند امتیاز سئو",
  severity_dist: "ایشوهای باز بر اساس شدت",
  recent_runs: "اسکن‌های اخیر",
  agent_activity: "فعالیت عامل",
  health: "سلامت سیستم",
  queue_depth: "عمق صف",
  worker: "ورکر",
  database: "دیتابیس",
  redis: "Redis",
  no_runs_yet: "هنوز اسکنی اجرا نشده. برای شروع، یک اسکن بزن.",

  new_project: "پروژه جدید",
  proj_site: "سایت",
  proj_lang: "زبان",
  proj_pages: "صفحات",
  proj_issues: "ایشو",

  run_header: "اجرای اسکن",
  crawled: "خزش‌شده",
  duration: "مدت",
  started: "شروع",
  indexable: "قابل ایندکس",
  page_url: "نشانی صفحه",
  title_len: "طول عنوان",
  meta: "متا",
  h1: "H1",
  canon: "Canonical",
  issues_n: "ایشو",
  tab_over: "نمای کلی",
  tab_pages: "صفحات",
  tab_rules: "قواعد",
  stop_scan: "توقف اسکن",

  issue_detail: "جزئیات ایشو",
  affected: "صفحات درگیر",
  history: "تاریخچه (فقط افزودنی)",
  suggested: "اصلاح پیشنهادی",
  no_issues: "هیچ ایشوی بازی وجود ندارد.",

  fix_policy:
    "سیاست اجرای امن: هر اصلاح ابتدا آزمایشی اجرا می‌شود، حداکثر {n} تغییر در هر اجرا، پیش از نوشتن snapshot گرفته می‌شود و بازگردانی یک‌کلیکی است.",
  before: "قبل",
  after: "بعد",
  target: "هدف",
  no_fixes: "اصلاح خودکاری در انتظار نیست.",

  appr_lock:
    "ریدایرکت، تغییر URL و ادغام صفحات هرگز بدون تأیید انسان اجرا نمی‌شوند — این قاعده در سطح سرور و در سطح دیتابیس اعمال می‌شود، نه فقط در رابط کاربری.",
  requested_by: "درخواست‌کننده",
  agent: "عامل خودکار",
  waiting: "در انتظار",
  no_approvals: "صف تأیید خالی است.",
  why: "دلیل",

  query: "عبارت جستجو",
  impressions: "نمایش",
  clicks: "کلیک",
  ctr: "CTR",
  position: "میانگین رتبه",
  gap: "فرصت",
  action_sugg: "اقدام پیشنهادی",
  content_needs_gsc:
    "این صفحه از داده‌ی Search Console ساخته می‌شود. تا زمانی که آن اتصال برقرار نشود اینجا خالی می‌ماند — هیچ عددی ساخته نمی‌شود.",

  conn_note:
    "برای اینستاگرام و یوتیوب هیچ داده‌ای ساخته نمی‌شود. اینترفیس، مدل داده و مدیریت توکن آماده است و تا اتصال OAuth واقعی وضعیت «متصل نیست» می‌ماند.",
  last_sync: "آخرین همگام‌سازی",
  scopes: "دسترسی‌ها",
  connect: "اتصال",
  manage: "مدیریت",
  test_connection: "تست اتصال",
  site_url: "نشانی سایت",
  username: "نام کاربری",
  app_password: "Application Password",

  s_general: "عمومی",
  s_team: "تیم و نقش‌ها",
  s_safety: "سیاست اجرا",
  s_keys: "کلیدهای API",
  s_log: "لاگ حسابرسی",
  role: "نقش",
  permission: "دسترسی",
  actor: "عامل",
  event: "رویداد",
  time: "زمان",
  your_role: "نقش شما",

  new_report: "گزارش جدید",
  schedule: "زمان‌بندی",
  format: "قالب",
  range: "بازه",
  download: "دانلود",
  reports_note:
    "گزارش‌ها از همان داده‌ی اسکن ساخته می‌شوند. هر گزارش، وضعیت را در لحظه‌ی ساخت نشان می‌دهد.",

  ob_step1: "افزودن سایت",
  ob_step2: "اتصال وردپرس",
  ob_step3: "زبان و محدودیت‌ها",
  ob_step4: "اولین اسکن",
  ob_next: "ذخیره و ادامه",
  ob_skip: "فعلاً رد کن",
  page_cap: "سقف صفحات در هر اسکن",
  crawl_rate: "نرخ درخواست خزنده (در ثانیه)",
  ob_what_happens: "در این مرحله چه اتفاقی می‌افتد",
  ob_l1: "خزنده robots.txt را می‌خواند و به آن احترام می‌گذارد.",
  ob_l2: "هر صفحه یک PageSnapshot تغییرناپذیر می‌سازد.",
  ob_l3: "ایشوها به‌صورت occurrence ثبت می‌شوند؛ رکورد قبلی هرگز بازنویسی نمی‌شود.",
  ob_l4: "برای هر پروژه همزمان فقط یک اسکن فعال است.",

  err_scan_active: "یک اسکن برای این پروژه در حال اجراست.",
  err_forbidden: "نقش شما اجازه‌ی این کار را ندارد.",
  err_rate: "درخواست‌های بیش از حد. کمی بعد دوباره تلاش کن.",
} as const;

type Dict = { [K in keyof typeof fa]: string };

const en: Dict = {
  product: "SEO Table",
  tagline: "SEO Console",
  nav_setup: "Setup",
  nav_analyze: "Analyze",
  nav_act: "Act",
  nav_system: "System",

  dashboard: "Dashboard",
  onboarding: "Onboarding",
  projects: "Projects",
  audit: "Audit Results",
  issues: "Issues",
  fixes: "Auto Fixes",
  approvals: "Approval Queue",
  content: "Content Opportunities",
  connectors: "Connectors",
  reports: "Reports",
  settings: "Settings",

  scan: "New scan",
  signin: "Sign in",
  signout: "Sign out",
  email: "Email",
  password: "Password",
  login_failed: "That email and password do not match",

  all: "All",
  search: "Search",
  export: "Export",
  details: "Details",
  view: "View",
  status: "Status",
  severity: "Severity",
  rule: "Rule",
  category: "Category",
  pages: "Pages",
  occurrences: "Occurrences",
  first_seen: "First seen",
  last_seen: "Last seen",
  last_scan: "Last scan",
  score: "Score",
  risk: "Risk",
  approve: "Approve",
  reject: "Reject",
  review: "Review",
  apply: "Apply",
  dry_run: "Dry run",
  rollback: "Roll back",
  preview: "Preview",
  loading: "Loading…",
  nothing_here: "Nothing to show",
  refresh: "Refresh",

  sev_critical: "Critical",
  sev_serious: "Serious",
  sev_warning: "Warning",
  sev_info: "Info",

  risk_low: "Low risk",
  risk_sensitive: "Sensitive",
  risk_restricted: "Approval required",

  st_queued: "Queued",
  st_running: "Running",
  st_succeeded: "Completed",
  st_failed: "Failed",
  st_canceled: "Cancelled",
  st_dead_letter: "Abandoned",
  st_open: "Open",
  st_fixed: "Fixed",
  st_ignored: "Ignored",
  st_draft: "Draft",
  st_awaiting_approval: "Awaiting approval",
  st_approved: "Approved",
  st_rejected: "Rejected",
  st_applying: "Applying",
  st_applied: "Applied",
  st_rolled_back: "Rolled back",
  st_connected: "Connected",
  st_not_connected: "Not connected",
  st_error: "Error",

  t_score: "SEO score",
  t_pages: "Indexable pages",
  t_open: "Open issues",
  t_pending: "Awaiting approval",
  vs_last: "vs. previous scan",
  of_crawled: "of {n} pages crawled",
  need_human: "need a human decision",
  score_trend: "SEO score over time",
  severity_dist: "Open issues by severity",
  recent_runs: "Recent scans",
  agent_activity: "Agent activity",
  health: "System health",
  queue_depth: "Queue depth",
  worker: "Worker",
  database: "Database",
  redis: "Redis",
  no_runs_yet: "No scan has run yet. Start one to see results here.",

  new_project: "New project",
  proj_site: "Site",
  proj_lang: "Language",
  proj_pages: "Pages",
  proj_issues: "Issues",

  run_header: "Scan run",
  crawled: "Crawled",
  duration: "Duration",
  started: "Started",
  indexable: "Indexable",
  page_url: "Page URL",
  title_len: "Title length",
  meta: "Meta",
  h1: "H1",
  canon: "Canonical",
  issues_n: "Issues",
  tab_over: "Overview",
  tab_pages: "Pages",
  tab_rules: "Rules",
  stop_scan: "Stop scan",

  issue_detail: "Issue detail",
  affected: "Affected pages",
  history: "History (append-only)",
  suggested: "Suggested fix",
  no_issues: "No open issues.",

  fix_policy:
    "Execution safety policy: every fix is dry-run first, capped at {n} changes per run, snapshotted before writing, and reversible in one click.",
  before: "Before",
  after: "After",
  target: "Target",
  no_fixes: "No automatic fixes are waiting.",

  appr_lock:
    "Redirects, URL changes and page merges never execute without human approval — enforced in the server and in the database, not just in this interface.",
  requested_by: "Requested by",
  agent: "Agent",
  waiting: "Waiting",
  no_approvals: "The approval queue is empty.",
  why: "Why",

  query: "Query",
  impressions: "Impressions",
  clicks: "Clicks",
  ctr: "CTR",
  position: "Avg. position",
  gap: "Opportunity",
  action_sugg: "Suggested action",
  content_needs_gsc:
    "This screen is built from Search Console data. Until that connector is live it stays empty — no figures are invented.",

  conn_note:
    "Nothing is fabricated for Instagram and YouTube. The interface, data model and token handling are ready; they stay “not connected” until real OAuth is wired.",
  last_sync: "Last sync",
  scopes: "Scopes",
  connect: "Connect",
  manage: "Manage",
  test_connection: "Test connection",
  site_url: "Site URL",
  username: "Username",
  app_password: "Application Password",

  s_general: "General",
  s_team: "Team & roles",
  s_safety: "Execution policy",
  s_keys: "API keys",
  s_log: "Audit log",
  role: "Role",
  permission: "Permission",
  actor: "Actor",
  event: "Event",
  time: "Time",
  your_role: "Your role",

  new_report: "New report",
  schedule: "Schedule",
  format: "Format",
  range: "Range",
  download: "Download",
  reports_note:
    "Reports are built from the same scan data. Each one shows the state at the moment it was generated.",

  ob_step1: "Add site",
  ob_step2: "Connect WordPress",
  ob_step3: "Language & limits",
  ob_step4: "First scan",
  ob_next: "Save and continue",
  ob_skip: "Skip for now",
  page_cap: "Page cap per scan",
  crawl_rate: "Crawler requests per second",
  ob_what_happens: "What happens next",
  ob_l1: "The crawler reads and respects robots.txt.",
  ob_l2: "Each page produces an immutable PageSnapshot.",
  ob_l3: "Issues are recorded as occurrences; prior records are never rewritten.",
  ob_l4: "Only one scan is active per project at a time.",

  err_scan_active: "A scan is already running for this project.",
  err_forbidden: "Your role does not allow that.",
  err_rate: "Too many requests. Try again shortly.",
};

const DICTS: Record<Locale, Dict> = { fa, en };

export type MessageKey = keyof Dict;

export function translator(locale: Locale) {
  const dict = DICTS[locale] ?? DICTS[DEFAULT_LOCALE];
  return function t(key: MessageKey, vars?: Record<string, string | number>): string {
    let out = dict[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        out = out.replaceAll(`{${k}}`, String(v));
      }
    }
    return out;
  };
}

export type T = ReturnType<typeof translator>;

export function isLocale(value: string | undefined | null): value is Locale {
  return value === "fa" || value === "en";
}
