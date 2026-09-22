import { TopBar } from "../../../components/shell";
import { Card, Note } from "../../../components/ui";
import { pageContext } from "../../../lib/page";
import { listConnectors, latestRunFor } from "../../../lib/queries";
import { Wizard } from "./wizard";
import { num } from "../../../lib/format";

export const dynamic = "force-dynamic";

/**
 * The stepper reflects real state rather than a stored wizard position: a project
 * exists or it does not, WordPress is connected or it is not, a run has happened
 * or it has not. Reload at any point and the wizard is where it should be.
 *
 * `?new=1` starts a further project from step 1; the wizard then continues with
 * `?project=<id>`, and `&wp=skip` records only that WordPress was put off.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string; wp?: string }>;
}) {
  const params = await searchParams;
  const { t, locale, project: current } = await pageContext();

  const project = params.new === "1" ? null : current;
  const connectors = project ? await listConnectors(project.id) : [];
  const wordpress = connectors.find((c) => c.kind === "WORDPRESS");
  const wordpressConnected = wordpress?.status === "CONNECTED";
  const firstRun = project ? await latestRunFor(project.id) : null;
  const skippedWordpress = params.wp === "skip";

  const step = !project ? 1 : !wordpressConnected && !skippedWordpress && !firstRun ? 2 : 4;
  const done = { 1: Boolean(project), 2: wordpressConnected, 3: Boolean(project), 4: Boolean(firstRun) };

  const steps = [
    { n: 1, label: t("ob_step1") },
    { n: 2, label: t("ob_step2") },
    { n: 3, label: t("ob_step3") },
    { n: 4, label: t("ob_step4") },
  ];

  return (
    <>
      <TopBar title={t("onboarding")} />
      <div className="view">
        <Card
          title={t("onboarding")}
          sub={t("step_of", { n: num(step, locale), m: num(4, locale) })}
        >
          <div className="steps">
            {steps.map((s) => (
              <div
                key={s.n}
                className={`step${done[s.n as 1 | 2 | 3 | 4] ? " done" : ""}${s.n === step && !done[s.n as 1 | 2 | 3 | 4] ? " now" : ""}`}
              >
                <span className="n">{done[s.n as 1 | 2 | 3 | 4] ? "✓" : num(s.n, locale)}</span>
                <span className="t">{s.label}</span>
              </div>
            ))}
          </div>
        </Card>

        <Wizard
          locale={locale}
          project={
            project
              ? {
                  id: project.id,
                  name: project.name,
                  baseUrl: project.baseUrl,
                  pageCap: project.pageCap,
                  crawlRate: project.crawlRate,
                }
              : null
          }
          wordpressConnected={wordpressConnected}
          skippedWordpress={skippedWordpress}
          hasRun={Boolean(firstRun)}
          labels={{
            step1: t("ob_step1"),
            step2: t("ob_step2"),
            step3: t("ob_step3"),
            step4: t("ob_step4"),
            projectLang: t("project_lang"),
            langFa: t("lang_fa"),
            langEn: t("lang_en"),
            siteUrl: t("site_url"),
            username: t("username"),
            appPassword: t("app_password"),
            pageCap: t("page_cap"),
            crawlRate: t("crawl_rate"),
            next: t("ob_next"),
            skip: t("ob_skip"),
            scan: t("scan"),
            test: t("test_connection"),
            name: t("project_name"),
            ready: t("ob_ready", {
              name: project?.name ?? "",
              cap: num(project?.pageCap ?? 0, locale),
              rate: num(project?.crawlRate ?? 0, locale),
            }),
            credNote: t("ob_cred_note"),
          }}
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
