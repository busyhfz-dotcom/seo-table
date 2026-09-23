import { can } from "@seo/core";
import { TopBar } from "../../../components/shell";
import { Card, Note } from "../../../components/ui";
import { pageContext } from "../../../lib/page";
import { latestRunFor } from "../../../lib/queries";
import { num } from "../../../lib/format";
import { connectStrings } from "../connect/keys";
import { loadConnection } from "../connect/load";
import { Wizard } from "./wizard";

export const dynamic = "force-dynamic";

/**
 * Add a site → see what it runs on and the method recommended for it →
 * connect (either approach) or skip → first scan.
 *
 * The stepper reflects real state rather than a stored wizard position: a
 * project exists or it does not, a connection can write to the site or it
 * cannot, a run has happened or it has not. Reload at any point and the wizard
 * is where it should be.
 *
 * `?new=1` starts a further project from step 1; the wizard then continues with
 * `?project=<id>`, and `&connect=skip` (formerly `&wp=skip`) records only that
 * connecting was put off.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string; wp?: string; connect?: string }>;
}) {
  const params = await searchParams;
  const { t, locale, session, project: current } = await pageContext();

  const project = params.new === "1" ? null : current;
  const [view, firstRun] = project ? await Promise.all([loadConnection(project, locale), latestRunFor(project.id)]) : [null, null];
  const status = (kind: string) => view?.methods.find((m) => m.kind === kind)?.status;
  // Connected enough to write: the edge installed, or WordPress connected.
  const writable = status("CLOUDFLARE") === "connected" || status("WORDPRESS") === "connected";
  const skipped = params.connect === "skip" || params.wp === "skip";

  const phase: "add" | "connect" | "scan" = !project ? "add" : !writable && !skipped && !firstRun ? "connect" : "scan";
  const done = {
    1: Boolean(project),
    2: Boolean(view?.platform),
    3: writable,
    4: Boolean(firstRun),
  };
  const now = phase === "add" ? 1 : phase === "connect" ? (view?.platform ? 3 : 2) : 4;

  const steps = [
    { n: 1, label: t("ob_step1") },
    { n: 2, label: t("ob_step2") },
    { n: 3, label: t("ob_step3") },
    { n: 4, label: t("ob_step4") },
  ] as const;

  return (
    <>
      <TopBar title={t("onboarding")} />
      <div className="view">
        <Card title={t("onboarding")} sub={t("step_of", { n: num(now, locale), m: num(4, locale) })}>
          <div className="steps">
            {steps.map((s) => (
              <div key={s.n} className={`step${done[s.n] ? " done" : ""}${s.n === now && !done[s.n] ? " now" : ""}`}>
                <span className="n">{done[s.n] ? "✓" : num(s.n, locale)}</span>
                <span className="t">{s.label}</span>
              </div>
            ))}
          </div>
        </Card>

        <Wizard
          locale={locale}
          phase={phase}
          view={view}
          project={project ? { id: project.id, name: project.name, pageCap: project.pageCap, crawlRate: project.crawlRate } : null}
          s={connectStrings(t)}
          canWrite={can(session.role, "connector:write")}
          canRun={can(session.role, "scan:run")}
        />

        <Card title={t("ob_what_happens")}>
          <ul className="plain">
            <li>{t("ob_l1")}</li>
            <li>{t("ob_l2")}</li>
            <li>{t("ob_l3")}</li>
            <li>{t("ob_l4")}</li>
          </ul>
        </Card>

        <Note tone="lock" icon="lock">
          {t("appr_lock")}
        </Note>
      </div>
    </>
  );
}
