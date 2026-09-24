"use client";

import { useState } from "react";
import { Card, Rich } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { ConfirmButton, CopyButton, Flash, Loading, Tabs, useAction, useLoad } from "../../../components/kit";
import { NotificationRow, type NotificationItem } from "../../../components/notifications";
import { callApi, apiErrorMessage } from "../../../lib/errors-ui";
import { dateTime, num, relative } from "../../../lib/format";
import { fmt } from "../../../lib/dict";
import { ALERT_KIND_HELP, ALERT_KIND_LABELS, ALERT_THRESHOLD_UNIT, CHANNEL_LABELS, SCHEDULE_KIND_LABELS, localized } from "../../../lib/seo-labels";
import type { CommonStrings } from "../../../lib/common-strings";
import type { Locale } from "../../../lib/i18n";
import { TIMEZONES, type AlertStrings } from "./strings";

type Channel = "in_app" | "webhook" | "telegram";
type Rule = { id: string; kind: string; threshold: number | null; channels: Channel[]; webhookUrl: string | null; enabled: boolean; hasWebhookSecret: boolean };
type Schedule = { kind: string; cron: string; timezone: string; enabled: boolean; lastRunAt: string | null; nextRunAt: string | null; lastError: string | null };
type Tab = "notifications" | "rules" | "schedules";

export type AlertsCtx = {
  projectId: string;
  locale: Locale;
  canWrite: boolean;
  telegram: boolean;
  integrations: string | null;
  initialTab: Tab;
};

const KINDS = ["score_drop", "new_critical", "rank_drop", "page_down", "cwv_regression", "index_drop"];

export function AlertsScreen({ ctx, s, c, bell }: { ctx: AlertsCtx; s: AlertStrings; c: CommonStrings; bell: { markRead: string; open: string } }) {
  const [tab, setTab] = useState<Tab>(ctx.initialTab);
  return (
    <>
      <Tabs
        label={s.tabs_label}
        locale={ctx.locale}
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "notifications", label: s.tab_notifications, icon: "bell" },
          { key: "rules", label: s.tab_rules, icon: "alert" },
          { key: "schedules", label: s.tab_schedules, icon: "clock" },
        ]}
      />
      {tab === "notifications" && <Notifications ctx={ctx} s={s} c={c} bell={bell} />}
      {tab === "rules" && <Rules ctx={ctx} s={s} c={c} />}
      {tab === "schedules" && <Schedules ctx={ctx} s={s} c={c} />}
    </>
  );
}

// ---------------------------------------------------------------- notifications

function Notifications({ ctx, s, c, bell }: { ctx: AlertsCtx; s: AlertStrings; c: CommonStrings; bell: { markRead: string; open: string } }) {
  const { locale } = ctx;
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [perPage, setPerPage] = useState(30);
  const list = useLoad<{ unread: number; total: number; items: NotificationItem[] }>(
    `/api/notifications?projectId=${encodeURIComponent(ctx.projectId)}&perPage=${perPage}${unreadOnly ? "&unread=1" : ""}`,
    locale,
  );
  async function read(id: string) {
    await callApi("/api/notifications/read", { method: "POST", body: { ids: [id] } });
    await list.reload();
  }
  async function readAll() {
    await callApi("/api/notifications/read-all", { method: "POST", body: { projectId: ctx.projectId } });
    await list.reload();
  }
  return (
    <Card
      title={s.tab_notifications}
      sub={list.data ? `${num(list.data.unread, locale)} / ${num(list.data.total, locale)}` : undefined}
      right={
        <div className="row">
          <label className="pick">
            <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
            {s.n_unread_only}
          </label>
          {(list.data?.unread ?? 0) > 0 && (
            <button type="button" className="btn ghost sm" onClick={() => void readAll()}>
              <Icon name="check" />
              {s.n_mark_all}
            </button>
          )}
        </div>
      }
      bare
    >
      {!list.data ? (
        list.error ? (
          <div style={{ padding: 18 }}>
            <Flash tone="crit">{list.error}</Flash>
          </div>
        ) : (
          <Loading label={c.loading} />
        )
      ) : list.data.items.length === 0 ? (
        <div className="empty">
          <Icon name="bell" />
          <div style={{ maxWidth: 460 }}>{s.n_empty}</div>
        </div>
      ) : (
        <>
          <ul className="notes-list">
            {list.data.items.map((n) => (
              <NotificationRow key={n.id} n={n} locale={locale} onRead={(id) => void read(id)} labels={bell} />
            ))}
          </ul>
          {list.data.total > list.data.items.length && (
            <div style={{ padding: 12, textAlign: "center" }}>
              <button type="button" className="btn ghost sm" onClick={() => setPerPage((p) => Math.min(200, p + 30))}>
                {s.n_more}
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- rules

function Rules({ ctx, s, c }: { ctx: AlertsCtx; s: AlertStrings; c: CommonStrings }) {
  const { locale } = ctx;
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/alerts`;
  const rules = useLoad<{ rules: Rule[]; defaults: Record<string, number | null> }>(base, locale);
  const [secret, setSecret] = useState<string | null>(null);

  return (
    <>
      <p className="desc">{s.r_intro}</p>
      {secret && (
        <div className="note lock">
          <Icon name="key" />
          <div className="stack" style={{ gap: 6, flex: 1 }}>
            <b>{s.r_secret_title}</b>
            <span>{s.r_secret_once}</span>
            <div className="row">
              <code className="inline-code" dir="ltr">
                {secret}
              </code>
              <CopyButton text={secret} c={c} />
              <button type="button" className="btn ghost sm" onClick={() => setSecret(null)}>
                {c.close}
              </button>
            </div>
          </div>
        </div>
      )}
      {!rules.data ? (
        rules.error ? <Flash tone="crit">{rules.error}</Flash> : <Loading label={c.loading} rows={5} />
      ) : (
        <>
          {rules.data.rules.length === 0 && <p className="muted small">{s.r_empty}</p>}
          {rules.data.rules.map((r) => (
            <RuleCard key={r.id} rule={r} ctx={ctx} s={s} c={c} base={base} defaults={rules.data!.defaults} onChanged={() => void rules.reload()} onSecret={setSecret} />
          ))}
          {ctx.canWrite && <NewRule ctx={ctx} s={s} c={c} base={base} defaults={rules.data.defaults} onCreated={(sec) => (sec && setSecret(sec), void rules.reload())} />}
        </>
      )}
    </>
  );
}

function RuleForm({
  kind,
  value,
  onChange,
  ctx,
  s,
  defaults,
  disabled,
}: {
  kind: string;
  value: { threshold: string; channels: Channel[]; webhookUrl: string };
  onChange: (v: { threshold: string; channels: Channel[]; webhookUrl: string }) => void;
  ctx: AlertsCtx;
  s: AlertStrings;
  defaults: Record<string, number | null>;
  disabled: boolean;
}) {
  const { locale } = ctx;
  const unit = ALERT_THRESHOLD_UNIT[kind];
  const toggle = (ch: Channel) =>
    onChange({ ...value, channels: value.channels.includes(ch) ? value.channels.filter((x) => x !== ch) : [...value.channels, ch] });
  return (
    <div className="formgrid">
      <label className="field">
        {s.r_threshold}
        {unit ? (
          <span className="row" style={{ flexWrap: "nowrap" }}>
            <input type="number" min={1} max={100} step="any" value={value.threshold} onChange={(e) => onChange({ ...value, threshold: e.target.value })} disabled={disabled} style={{ maxWidth: 110 }} dir="ltr" />
            <span className="muted small">{unit[locale]}</span>
          </span>
        ) : (
          <span className="muted small">{s.r_no_threshold}</span>
        )}
        {unit && defaults[kind] != null && <span className="hint">{fmt(s.r_default, { n: num(defaults[kind]!, locale) })}</span>}
      </label>
      <fieldset className="checkset">
        <legend>{s.r_channels}</legend>
        {(["in_app", "webhook", "telegram"] as Channel[]).map((ch) => (
          <label key={ch} className="pick">
            <input type="checkbox" checked={value.channels.includes(ch)} onChange={() => toggle(ch)} disabled={disabled} />
            {CHANNEL_LABELS[ch]![locale]}
          </label>
        ))}
      </fieldset>
      {value.channels.includes("webhook") && (
        <label className="field span2">
          {s.r_webhook_url}
          <input type="url" value={value.webhookUrl} onChange={(e) => onChange({ ...value, webhookUrl: e.target.value })} dir="ltr" required disabled={disabled} />
          <span className="hint">
            <Rich text={s.r_webhook_help} />
          </span>
        </label>
      )}
      {value.channels.includes("telegram") && !ctx.telegram && (
        <p className="small span2" style={{ color: "var(--warn)" }}>
          <Icon name="alert" /> {s.r_telegram_missing}{" "}
          {ctx.integrations && (
            <a className="lnk" href={ctx.integrations}>
              {s.r_open_integrations}
            </a>
          )}
        </p>
      )}
    </div>
  );
}

function RuleCard({
  rule,
  ctx,
  s,
  c,
  base,
  defaults,
  onChanged,
  onSecret,
}: {
  rule: Rule;
  ctx: AlertsCtx;
  s: AlertStrings;
  c: CommonStrings;
  base: string;
  defaults: Record<string, number | null>;
  onChanged: () => void;
  onSecret: (secret: string) => void;
}) {
  const { locale } = ctx;
  const [form, setForm] = useState({ threshold: rule.threshold === null ? "" : String(rule.threshold), channels: rule.channels, webhookUrl: rule.webhookUrl ?? "" });
  const save = useAction(locale);
  const [tested, setTested] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const url = `${base}/${encodeURIComponent(rule.id)}`;

  async function patch(body: Record<string, unknown>) {
    setSaved(false);
    const r = await save.run<{ webhookSecret: string | null }>(url, { method: "PATCH", body });
    if (!r) return;
    if (r.webhookSecret) onSecret(r.webhookSecret);
    setSaved(true);
    onChanged();
  }

  async function test() {
    setTested(null);
    const r = await save.run<{ webhook: { ok: boolean; text: { fa: string; en: string } | null } | null; telegram: { ok: boolean; text: { fa: string; en: string } | null } | null }>(`${url}/test`);
    if (!r) return;
    const lines: string[] = [];
    for (const ch of ["webhook", "telegram"] as const) {
      const x = r[ch];
      if (!x) continue;
      const name = CHANNEL_LABELS[ch]![locale];
      lines.push(x.ok ? fmt(s.r_test_ok, { channel: name }) : fmt(s.r_test_fail, { channel: name, reason: localized(x.text, locale) }));
    }
    setTested(lines.length ? lines : [s.r_test_none]);
  }

  return (
    <Card
      title={ALERT_KIND_LABELS[rule.kind]?.[locale] ?? rule.kind}
      right={
        <div className="row">
          <label className="switch">
            <input type="checkbox" checked={rule.enabled} disabled={!ctx.canWrite || save.busy} onChange={(e) => void patch({ enabled: e.target.checked })} />
            <span>{rule.enabled ? s.r_enabled : s.r_disabled}</span>
          </label>
        </div>
      }
    >
      <div className="stack">
        <p className="hint">{ALERT_KIND_HELP[rule.kind]?.[locale]}</p>
        <RuleForm kind={rule.kind} value={form} onChange={setForm} ctx={ctx} s={s} defaults={defaults} disabled={!ctx.canWrite} />
        {rule.hasWebhookSecret && (
          <span className="pill mute" style={{ alignSelf: "flex-start" }}>
            <Icon name="key" />
            {s.r_has_secret}
          </span>
        )}
        {save.error && <Flash tone="crit">{save.error}</Flash>}
        {saved && !save.error && <Flash tone="ok">{c.saved}</Flash>}
        {tested && (
          <Flash tone="info">
            {tested.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </Flash>
        )}
        {ctx.canWrite && (
          <div className="row">
            <button
              type="button"
              className="btn primary sm"
              disabled={save.busy || form.channels.length === 0}
              onClick={() =>
                void patch({
                  channels: form.channels,
                  webhookUrl: form.channels.includes("webhook") ? form.webhookUrl.trim() || null : null,
                  ...(ALERT_THRESHOLD_UNIT[rule.kind] && form.threshold ? { threshold: Number(form.threshold) } : {}),
                })
              }
            >
              <Icon name="check" />
              {s.r_save}
            </button>
            <button type="button" className="btn ghost sm" disabled={save.busy} onClick={() => void test()}>
              <Icon name="send" />
              {s.r_test}
            </button>
            {rule.webhookUrl && (
              <button type="button" className="btn ghost sm" disabled={save.busy} onClick={() => void patch({ rotateSecret: true })}>
                <Icon name="key" />
                {s.r_rotate}
              </button>
            )}
            <span className="spacer" />
            <ConfirmButton
              label={c.delete}
              confirmLabel={c.confirm}
              disabled={save.busy}
              onConfirm={async () => {
                if (await save.run(url, { method: "DELETE" })) onChanged();
              }}
            />
          </div>
        )}
      </div>
    </Card>
  );
}

function NewRule({ ctx, s, c, base, defaults, onCreated }: { ctx: AlertsCtx; s: AlertStrings; c: CommonStrings; base: string; defaults: Record<string, number | null>; onCreated: (secret: string | null) => void }) {
  const { locale } = ctx;
  const [kind, setKind] = useState(KINDS[0]!);
  const [form, setForm] = useState<{ threshold: string; channels: Channel[]; webhookUrl: string }>({ threshold: "", channels: ["in_app"], webhookUrl: "" });
  const create = useAction(locale);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = await create.run<{ webhookSecret: string | null }>(base, {
      body: {
        kind,
        channels: form.channels,
        ...(form.channels.includes("webhook") ? { webhookUrl: form.webhookUrl.trim() } : {}),
        ...(ALERT_THRESHOLD_UNIT[kind] && form.threshold ? { threshold: Number(form.threshold) } : {}),
      },
    });
    if (!r) return;
    setForm({ threshold: "", channels: ["in_app"], webhookUrl: "" });
    onCreated(r.webhookSecret);
  }
  return (
    <Card title={s.r_new}>
      <form className="stack" onSubmit={submit}>
        <label className="field" style={{ maxWidth: 360 }}>
          {s.r_kind}
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {ALERT_KIND_LABELS[k]![locale]}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">{ALERT_KIND_HELP[kind]?.[locale]}</p>
        <RuleForm kind={kind} value={form} onChange={setForm} ctx={ctx} s={s} defaults={defaults} disabled={false} />
        {create.error && <Flash tone="crit">{create.error}</Flash>}
        <div>
          <button type="submit" className="btn primary" disabled={create.busy || form.channels.length === 0}>
            <Icon name="plus" />
            {create.busy ? c.saving : s.r_create}
          </button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- schedules

type Preset = { kind: "hourly" | "every" | "daily" | "weekly" | "monthly" | "custom"; minute: number; hour: number; every: number; weekday: number; monthday: number; cron: string };

/** The friendly form of a cron expression, when it has one. */
function parseCron(cron: string): Preset {
  const base: Preset = { kind: "custom", minute: 0, hour: 3, every: 6, weekday: 1, monthday: 1, cron };
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return base;
  const [mi, h, dom, mon, dow] = f as [string, string, string, string, string];
  const n = (v: string) => (/^\d+$/.test(v) ? Number(v) : null);
  const minute = n(mi);
  if (minute === null || mon !== "*") return base;
  if (h === "*" && dom === "*" && dow === "*") return { ...base, kind: "hourly", minute };
  const every = h.match(/^\*\/(\d+)$/);
  if (every && dom === "*" && dow === "*") return { ...base, kind: "every", minute, every: Number(every[1]) };
  const hour = n(h);
  if (hour === null) return base;
  if (dom === "*" && dow === "*") return { ...base, kind: "daily", minute, hour };
  if (dom === "*" && n(dow) !== null) return { ...base, kind: "weekly", minute, hour, weekday: n(dow)! };
  if (dow === "*" && n(dom) !== null) return { ...base, kind: "monthly", minute, hour, monthday: n(dom)! };
  return base;
}

function toCron(p: Preset): string {
  switch (p.kind) {
    case "hourly":
      return `${p.minute} * * * *`;
    case "every":
      return `${p.minute} */${p.every} * * *`;
    case "daily":
      return `${p.minute} ${p.hour} * * *`;
    case "weekly":
      return `${p.minute} ${p.hour} * * ${p.weekday}`;
    case "monthly":
      return `${p.minute} ${p.hour} ${p.monthday} * *`;
    case "custom":
      return p.cron.trim();
  }
}

function Schedules({ ctx, s, c }: { ctx: AlertsCtx; s: AlertStrings; c: CommonStrings }) {
  const list = useLoad<{ schedules: Schedule[] }>(`/api/projects/${encodeURIComponent(ctx.projectId)}/schedules`, ctx.locale);
  return (
    <>
      <p className="desc">{s.s_intro}</p>
      {!list.data ? (
        list.error ? <Flash tone="crit">{list.error}</Flash> : <Loading label={c.loading} rows={5} />
      ) : (
        list.data.schedules.map((sc) => <ScheduleCard key={sc.kind} sc={sc} ctx={ctx} s={s} c={c} onSaved={() => void list.reload()} />)
      )}
    </>
  );
}

function ScheduleCard({ sc, ctx, s, c, onSaved }: { sc: Schedule; ctx: AlertsCtx; s: AlertStrings; c: CommonStrings; onSaved: () => void }) {
  const { locale } = ctx;
  const [p, setP] = useState<Preset>(() => parseCron(sc.cron));
  const [tz, setTz] = useState(sc.timezone);
  const [enabled, setEnabled] = useState(sc.enabled);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const zones = TIMEZONES.includes(tz as (typeof TIMEZONES)[number]) ? [...TIMEZONES] : [tz, ...TIMEZONES];
  const tzLabel = (z: string) => (s as Record<string, string>)[`tz_${z}`] ?? z;
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = [0, 5, 10, 15, 20, 30, 40, 45, 50];
  const pad = (v: number) => num(v, locale).padStart(2, locale === "fa" ? "۰" : "0");

  async function save(nextEnabled = enabled) {
    setBusy(true);
    setError(null);
    setSaved(false);
    const r = await callApi(`/api/projects/${encodeURIComponent(ctx.projectId)}/schedules/${sc.kind}`, {
      method: "PUT",
      body: { cron: toCron(p), timezone: tz, enabled: nextEnabled },
    });
    setBusy(false);
    if (!r.ok) {
      const field = r.failure.details?.field;
      setError(field === "cron" ? s.s_invalid_cron : field === "timezone" ? s.s_invalid_tz : apiErrorMessage(locale, r.failure));
      return;
    }
    setSaved(true);
    onSaved();
  }

  return (
    <Card
      title={SCHEDULE_KIND_LABELS[sc.kind]?.[locale] ?? sc.kind}
      right={
        <label className="switch">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!ctx.canWrite || busy}
            onChange={(e) => {
              setEnabled(e.target.checked);
              void save(e.target.checked);
            }}
          />
          <span>{enabled ? s.r_enabled : s.r_disabled}</span>
        </label>
      }
    >
      <div className="stack">
        <div className="formgrid">
          <label className="field">
            {s.s_when}
            <select value={p.kind} onChange={(e) => setP({ ...p, kind: e.target.value as Preset["kind"], cron: toCron(p) })} disabled={!ctx.canWrite}>
              <option value="hourly">{s.s_preset_hourly}</option>
              <option value="every">{s.s_preset_every}</option>
              <option value="daily">{s.s_preset_daily}</option>
              <option value="weekly">{s.s_preset_weekly}</option>
              <option value="monthly">{s.s_preset_monthly}</option>
              <option value="custom">{s.s_preset_custom}</option>
            </select>
          </label>
          {p.kind === "every" && (
            <label className="field">
              {s.s_hours}
              <select value={p.every} onChange={(e) => setP({ ...p, every: Number(e.target.value) })} disabled={!ctx.canWrite}>
                {[2, 3, 4, 6, 8, 12].map((h) => (
                  <option key={h} value={h}>
                    {fmt(s.s_every_n, { n: num(h, locale) })}
                  </option>
                ))}
              </select>
            </label>
          )}
          {p.kind === "weekly" && (
            <label className="field">
              {s.s_weekday}
              <select value={p.weekday} onChange={(e) => setP({ ...p, weekday: Number(e.target.value) })} disabled={!ctx.canWrite}>
                {[6, 0, 1, 2, 3, 4, 5].map((d) => (
                  <option key={d} value={d}>
                    {(s as Record<string, string>)[`day_${d}`]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {p.kind === "monthly" && (
            <label className="field">
              {s.s_monthday}
              <select value={p.monthday} onChange={(e) => setP({ ...p, monthday: Number(e.target.value) })} disabled={!ctx.canWrite}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {num(d, locale)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(p.kind === "daily" || p.kind === "weekly" || p.kind === "monthly") && (
            <label className="field">
              {s.s_at}
              <select value={p.hour} onChange={(e) => setP({ ...p, hour: Number(e.target.value) })} disabled={!ctx.canWrite}>
                {hours.map((h) => (
                  <option key={h} value={h}>
                    {pad(h)}:{pad(p.minute)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {p.kind !== "custom" && (
            <label className="field">
              {s.s_minute}
              <select value={p.minute} onChange={(e) => setP({ ...p, minute: Number(e.target.value) })} disabled={!ctx.canWrite}>
                {[...new Set([...minutes, p.minute])].sort((a, b) => a - b).map((m) => (
                  <option key={m} value={m}>
                    {pad(m)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {p.kind === "custom" && (
            <label className="field">
              {s.s_cron}
              <input value={p.cron} onChange={(e) => setP({ ...p, cron: e.target.value })} dir="ltr" disabled={!ctx.canWrite} translate="no" />
              <span className="hint">
                <Rich text={s.s_cron_help} />
              </span>
            </label>
          )}
          <label className="field">
            {s.s_timezone}
            <select value={tz} onChange={(e) => setTz(e.target.value)} disabled={!ctx.canWrite}>
              {zones.map((z) => (
                <option key={z} value={z} translate={tzLabel(z) === z ? "no" : undefined}>
                  {tzLabel(z)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <dl className="kv compact">
          <dt>{s.s_next}</dt>
          <dd>{sc.nextRunAt ? `${dateTime(sc.nextRunAt, locale)} (${relative(sc.nextRunAt, locale)})` : "—"}</dd>
          <dt>{s.s_last}</dt>
          <dd>{sc.lastRunAt ? relative(sc.lastRunAt, locale) : c.never}</dd>
          {sc.lastError && (
            <>
              <dt>{s.s_last_error}</dt>
              <dd>{sc.lastError === "scan_active" ? s.s_scan_active : <code className="inline-code">{sc.lastError.slice(0, 160)}</code>}</dd>
            </>
          )}
        </dl>
        {error && <Flash tone="crit">{error}</Flash>}
        {saved && !error && <Flash tone="ok">{s.s_saved}</Flash>}
        {ctx.canWrite && (
          <div>
            <button type="button" className="btn primary sm" disabled={busy} onClick={() => void save()}>
              <Icon name="check" />
              {busy ? c.saving : c.save}
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}
