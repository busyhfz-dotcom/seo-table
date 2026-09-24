"use client";

import { useState } from "react";
import { Card } from "../../../../components/ui";
import { Icon } from "../../../../components/icons";
import { Rich } from "../../../../components/ui";
import { Flash, Loading, useAction, useLoad } from "../../../../components/kit";
import { callApi, apiErrorMessage } from "../../../../lib/errors-ui";
import { num, pathOf } from "../../../../lib/format";
import { fmt } from "../../../../lib/dict";
import { LocText } from "../../../../components/loc-text";
import type { CommonStrings } from "../../../../lib/common-strings";
import type { Locale } from "../../../../lib/i18n";
import type { ToolStrings } from "../strings";
import { ApplyResult, TargetNote, type ApplyTarget, type Proposal } from "../shared";

type Issue = { line: number | null; level: "error" | "warning" | "info"; code: string; message: { fa: string; en: string } };
type RobotsFile = { url: string; state: "ok" | "missing" | "unreachable"; status: number | null; body: string };
type Live = { file: RobotsFile; issues: Issue[]; suggested: string | null; apply: ApplyTarget };
type Verdict = { url: string; userAgent: string; allowed: boolean; group: string | null; rule: { allow: boolean; pattern: string; line: number; text: string } | null };
type Review = {
  issues: Issue[];
  diff: Array<{ op: "=" | "+" | "-"; line: string; oldNo: number | null; newNo: number | null }>;
  newlyBlocked: Array<{ url: string; clicks: number | null; rule: Verdict["rule"] }>;
  newlyAllowed: number;
  checkedUrls: number;
};

export type RobotsCtx = { projectId: string; baseUrl: string; locale: Locale; canPropose: boolean; links: { fixes: string; approvals: string; connect: string } };

const AGENTS = ["Googlebot", "Bingbot", "*"];

export function RobotsScreen({ ctx, s, c }: { ctx: RobotsCtx; s: ToolStrings; c: CommonStrings }) {
  const { locale } = ctx;
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/robots`;
  const live = useLoad<Live>(base, locale);
  const [draft, setDraft] = useState<string | null>(null);

  if (!live.data) return live.error ? <Flash tone="crit">{live.error}</Flash> : <Loading label={c.loading} rows={6} />;
  const current = live.data.file;
  const text = draft ?? (current.state === "ok" ? current.body : (live.data.suggested ?? ""));

  return (
    <>
      <div className="split">
        <Card
          title={s.rb_current}
          sub={
            <a className="url lnk" href={current.url} target="_blank" rel="noreferrer" dir="ltr">
              {current.url}
            </a>
          }
          right={
            <span className={`pill ${current.state === "ok" ? "ok" : current.state === "missing" ? "warn" : "crit"}`}>
              {current.state === "ok" ? s.rb_state_ok : current.state === "missing" ? s.rb_state_missing : s.rb_state_unreachable}
            </span>
          }
        >
          <div className="stack">
            {current.state === "ok" ? (
              current.body.trim() ? <pre className="code-block">{current.body}</pre> : <p className="muted small">{s.rb_empty}</p>
            ) : (
              live.data.suggested && <Flash tone="info">{s.rb_suggested}</Flash>
            )}
            {current.state === "ok" && (
              <>
                <h4>{s.issues}</h4>
                <RobotsIssues issues={live.data.issues} s={s} locale={locale} />
              </>
            )}
          </div>
        </Card>
        <Tester ctx={ctx} s={s} c={c} edited={draft} />
      </div>

      <Editor ctx={ctx} s={s} c={c} text={text} setText={setDraft} live={live.data} onReset={() => setDraft(null)} />
    </>
  );
}

function RobotsIssues({ issues, s, locale }: { issues: Issue[]; s: ToolStrings; locale: Locale }) {
  if (!issues.length)
    return (
      <p className="small" style={{ color: "var(--ok)" }}>
        <Icon name="check" /> {s.no_issues}
      </p>
    );
  return (
    <ul className="checks">
      {issues.map((x, i) => (
        <li key={i} className={x.level === "error" ? "fail" : x.level === "warning" ? "warn" : "na"}>
          <Icon name={x.level === "error" ? "x" : x.level === "warning" ? "alert" : "info"} />
          <span>
            {x.line !== null && <b>{fmt(s.line_n, { n: num(x.line, locale) })}: </b>}
            <LocText pair={x.message} locale={locale} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function Tester({ ctx, s, c, edited }: { ctx: RobotsCtx; s: ToolStrings; c: CommonStrings; edited: string | null }) {
  const { locale } = ctx;
  const [urls, setUrls] = useState("/\n");
  const [agents, setAgents] = useState<string[]>(["Googlebot"]);
  const [custom, setCustom] = useState("");
  const [against, setAgainst] = useState<"live" | "edit">("live");
  const act = useAction(locale);
  const [results, setResults] = useState<Verdict[] | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const list = urls
      .split("\n")
      .map((u) => u.trim())
      .filter(Boolean)
      .slice(0, 100);
    const ua = [...agents, ...(custom.trim() ? [custom.trim()] : [])];
    const r = await act.run<{ results: Verdict[] }>(`/api/projects/${encodeURIComponent(ctx.projectId)}/robots/test`, {
      body: { urls: list, userAgents: ua, ...(against === "edit" && edited !== null ? { robotsTxt: edited } : {}) },
    });
    setResults(r?.results ?? null);
  }

  return (
    <Card title={s.rb_tester}>
      <form className="stack" onSubmit={run}>
        <p className="hint">
          <Rich text={s.rb_tester_help} />
        </p>
        <textarea className="code" style={{ minHeight: 90 }} value={urls} onChange={(e) => setUrls(e.target.value)} aria-label={s.page_url} translate="no" />
        <fieldset className="checkset">
          <legend>{s.rb_agents}</legend>
          {AGENTS.map((a) => (
            <label key={a} className="pick">
              <input type="checkbox" checked={agents.includes(a)} onChange={(e) => setAgents((prev) => (e.target.checked ? [...prev, a] : prev.filter((x) => x !== a)))} />
              <code dir="ltr">{a}</code>
            </label>
          ))}
          <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={s.rb_agent_custom} aria-label={s.rb_agent_custom} dir="ltr" style={{ width: 160 }} />
        </fieldset>
        {edited !== null && (
          <div className="seg" role="group" aria-label={s.rb_against}>
            <button type="button" aria-pressed={against === "live"} onClick={() => setAgainst("live")}>
              {s.rb_against_live}
            </button>
            <button type="button" aria-pressed={against === "edit"} onClick={() => setAgainst("edit")}>
              {s.rb_against_edit}
            </button>
          </div>
        )}
        <div>
          <button type="submit" className="btn primary" disabled={act.busy || !urls.trim() || (agents.length === 0 && !custom.trim())}>
            <Icon name="play" />
            {act.busy ? c.loading : s.rb_test_run}
          </button>
        </div>
      </form>
      {act.error && (
        <div style={{ marginTop: 10 }}>
          <Flash tone="crit">{act.error}</Flash>
        </div>
      )}
      {results && (
        <div className="tw" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>{c.url}</th>
                <th>{s.rb_agents}</th>
                <th>{c.details}</th>
                <th>{s.rb_rule}</th>
              </tr>
            </thead>
            <tbody>
              {results.map((v, i) => (
                <tr key={i}>
                  <td className="path" dir="ltr">
                    {pathOf(v.url)}
                  </td>
                  <td>
                    <code className="inline-code">{v.userAgent}</code>
                  </td>
                  <td>
                    <span className={`pill ${v.allowed ? "ok" : "crit"}`}>
                      <Icon name={v.allowed ? "check" : "lock"} />
                      {v.allowed ? s.rb_allowed : s.rb_blocked}
                    </span>
                  </td>
                  <td>
                    {v.rule ? (
                      <span className="small">
                        {fmt(s.line_n, { n: num(v.rule.line, locale) })} <code className="inline-code">{v.rule.text}</code>
                      </span>
                    ) : (
                      <span className="muted small">{s.rb_no_rule}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Editor({
  ctx,
  s,
  c,
  text,
  setText,
  live,
  onReset,
}: {
  ctx: RobotsCtx;
  s: ToolStrings;
  c: CommonStrings;
  text: string;
  setText: (v: string) => void;
  live: Live;
  onReset: () => void;
}) {
  const { locale } = ctx;
  const review = useAction(locale);
  const [result, setResult] = useState<Review | null>(null);
  const [applied, setApplied] = useState<{ proposal: Proposal; target: ApplyTarget } | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [applying, setApplying] = useState(false);
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/robots`;

  async function doReview() {
    setApplied(null);
    setResult(await review.run<Review>(`${base}/validate`, { body: { content: text } }));
  }

  async function apply() {
    setApplyError(null);
    setManual(false);
    setApplying(true);
    const r = await callApi<{ proposal: Proposal; target: ApplyTarget }>(`${base}/apply`, { method: "POST", body: { content: text } });
    setApplying(false);
    if (r.ok) setApplied(r.data);
    else if (r.failure.status === 409 && r.failure.details?.manual) setManual(true);
    else setApplyError(apiErrorMessage(locale, r.failure));
  }

  function download() {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "robots.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const errors = result?.issues.filter((i) => i.level === "error").length ?? 0;

  return (
    <Card
      title={s.rb_editor}
      right={
        <div className="row">
          <button type="button" className="btn ghost sm" onClick={onReset}>
            <Icon name="undo" />
            {s.rb_reset}
          </button>
          <button type="button" className="btn ghost sm" onClick={download}>
            <Icon name="dl" />
            {s.download_file}
          </button>
        </div>
      }
    >
      <div className="stack">
        <textarea
          className="code"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setResult(null);
          }}
          aria-label={s.rb_editor}
          spellCheck={false}
          translate="no"
        />
        <div>
          <button type="button" className="btn" disabled={review.busy} onClick={() => void doReview()}>
            <Icon name="eye" />
            {review.busy ? c.loading : s.rb_review}
          </button>
        </div>
        {review.error && <Flash tone="crit">{review.error}</Flash>}
        {result && (
          <>
            <h4>{s.issues}</h4>
            <RobotsIssues issues={result.issues} s={s} locale={locale} />
            <h4>{s.rb_diff}</h4>
            {result.diff.every((d) => d.op === "=") ? (
              <p className="muted small">{s.rb_no_diff}</p>
            ) : (
              <div className="difflines" translate="no">
                {result.diff.map((d, i) => (
                  <div key={i} className={d.op === "+" ? "add" : d.op === "-" ? "del" : undefined}>
                    <span className="n">{d.oldNo ?? ""}</span>
                    <span className="n">{d.newNo ?? ""}</span>
                    <span>{d.op === "=" ? " " : d.op}</span>
                    <span>{d.line}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="small muted">
              {fmt(s.rb_checked, { n: num(result.checkedUrls, locale) })}
              {result.newlyAllowed > 0 && ` ${fmt(s.rb_newly_allowed, { n: num(result.newlyAllowed, locale) })}`}
            </p>
            {result.newlyBlocked.length > 0 && (
              <div className="note crit">
                <Icon name="alert" />
                <div>
                  <b>{s.rb_newly_blocked}</b>
                  <div className="small">{s.rb_newly_blocked_help}</div>
                  <ul className="plain">
                    {result.newlyBlocked.slice(0, 30).map((b) => (
                      <li key={b.url}>
                        <span className="url" dir="ltr">
                          {pathOf(b.url)}
                        </span>
                        {b.rule && (
                          <>
                            {" "}
                            <code className="inline-code">{b.rule.text}</code>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            <section className="stack">
              <h4>{s.apply_title}</h4>
              <p className="hint">{s.apply_help}</p>
              <TargetNote target={live.apply} s={s} c={c} connectHref={ctx.links.connect} />
              {ctx.canPropose ? (
                <div>
                  <button type="button" className="btn primary" disabled={errors > 0 || applying || !live.apply.supported} onClick={() => void apply()}>
                    <Icon name="wand" />
                    {s.propose}
                  </button>
                </div>
              ) : (
                <p className="muted small">{c.read_only}</p>
              )}
              {applyError && <Flash tone="crit">{applyError}</Flash>}
              {manual && <Flash tone="warn">{c.manual_only}</Flash>}
              {applied && <ApplyResult proposal={applied.proposal} target={applied.target} links={ctx.links} s={s} c={c} />}
            </section>
          </>
        )}
      </div>
    </Card>
  );
}
