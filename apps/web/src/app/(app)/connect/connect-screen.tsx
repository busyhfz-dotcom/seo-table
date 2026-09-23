"use client";

/**
 * Connect site: the audit → permission → connect → apply path for one
 * project, with the two approaches side by side.
 */
import Link from "next/link";
import { Icon } from "../../../components/icons";
import { UserText } from "../../../components/ui";
import { num } from "../../../lib/format";
import type { Locale } from "../../../lib/i18n";
import type { ConnectStrings } from "./keys";
import type { ConnectionView } from "./load";
import {
  BridgeMethod,
  CloudflareMethod,
  FixPackMethod,
  PlatformCard,
  WordPressMethod,
  WriteTargetCard,
  methodIcon,
} from "./methods";
import { ConnectProvider } from "./parts";
import { SearchConsoleCard } from "./search-console";

export function ConnectScreen({
  view,
  s,
  locale,
  canWrite,
  canRun,
  auditHref,
}: {
  view: ConnectionView;
  s: ConnectStrings;
  locale: Locale;
  canWrite: boolean;
  canRun: boolean;
  auditHref: string;
}) {
  const m = (kind: string) => view.methods.find((x) => x.kind === kind)!;
  const cf = m("CLOUDFLARE");
  const wp = m("WORDPRESS");
  const writing =
    view.writeTarget.effective === "CLOUDFLARE" ? cf.status === "connected" : wp.status === "connected";
  const effectiveKind = view.writeTarget.effective;
  const n = (v: number) => num(v, locale);

  return (
    <ConnectProvider value={{ s, locale, projectId: view.projectId, baseUrl: view.baseUrl, canWrite, canRun }}>
      <section className="card connect-hero">
        <div className="body">
          <div className="hero-top">
            <div>
              <h2>{s.cn_intro_title}</h2>
              <p className="site">
                <Icon name="globe" />
                <UserText>{view.projectName}</UserText>
                <span className="url" dir="ltr" translate="no">
                  {view.host}
                </span>
              </p>
            </div>
            <div className={`now ${writing ? "ok" : "warn"}`}>
              <span className="k">{s.cn_target_now}</span>
              <b>
                <Icon name={writing ? methodIcon(effectiveKind) : "box"} />
                {writing ? s[`tg_${effectiveKind}`] : s.m_FIX_PACK}
              </b>
            </div>
          </div>
          <p className="desc">{s.cn_intro}</p>
          <ol className="flow">
            <li className={view.hasRun ? "done" : "now"}>
              <span className="n">{view.hasRun ? <Icon name="check" /> : n(1)}</span>
              {s.cn_flow_audit}
            </li>
            <li className={writing ? "done" : view.hasRun ? "now" : ""}>
              <span className="n">{writing ? <Icon name="check" /> : n(2)}</span>
              {s.cn_flow_permission}
            </li>
            <li className={writing ? "done" : ""}>
              <span className="n">{writing ? <Icon name="check" /> : n(3)}</span>
              {s.cn_flow_connect}
            </li>
            <li className={writing ? "now" : ""}>
              <span className="n">{n(4)}</span>
              {s.cn_flow_apply}
            </li>
          </ol>
          {!view.hasRun && (
            <div className="note">
              <Icon name="info" />
              <div>
                {s.cn_audit_first}{" "}
                <Link href={auditHref} className="lnk">
                  {s.cn_open_audit}
                </Link>
              </div>
            </div>
          )}
          {!writing && view.hasRun && (
            <div className="note">
              <Icon name="info" />
              <div>{s.cn_target_none}</div>
            </div>
          )}
        </div>
      </section>

      <div className="grid g2">
        <PlatformCard platform={view.platform} detectedLabel={view.detectedLabel} />
        <WriteTargetCard view={view} />
      </div>

      <div className="approaches">
        <div className="approach">
          <div className="approach-h">
            <Icon name="shield" />
            <div>
              <h2>{s.cn_noinstall_title}</h2>
              <p>{s.cn_noinstall_sub}</p>
            </div>
          </div>
          <CloudflareMethod method={cf} />
          <WordPressMethod method={wp} platform={view.platform} />
          <FixPackMethod method={m("FIX_PACK")} pack={view.fixPack} />
        </div>
        <div className="approach">
          <div className="approach-h">
            <Icon name="puzzle" />
            <div>
              <h2>{s.cn_plugin_title}</h2>
              <p>{s.cn_plugin_sub}</p>
            </div>
          </div>
          <BridgeMethod method={m("WORDPRESS_BRIDGE")} wordpress={wp} />
        </div>
      </div>

      <SearchConsoleCard status={view.searchConsole.status} lastError={view.searchConsole.lastError} />
    </ConnectProvider>
  );
}
