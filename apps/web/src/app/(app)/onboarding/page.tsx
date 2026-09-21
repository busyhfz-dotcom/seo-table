import { TopBar } from "../../../components/shell";
import { Card, Note } from "../../../components/ui";
import { pageContext } from "../../../lib/page";
import { defaultProject, listConnectors, latestRunFor } from "../../../lib/queries";
import { Wizard } from "./wizard";
import { num } from "../../../lib/format";

export const dynamic = "force-dynamic";

/**
 * The stepper reflects real state rather than a stored wizard position: a project
 * exists or it does not, WordPress is connected or it is not, a run has happened
 * or it has not. Reload at any point and the wizard is where it should be.
 */
export default async function OnboardingPage() {
  const { t, locale, pathname, session } = await pageContext();

  const project = await defaultProject(session.orgId);
  const connectors = project ? await listConnectors(project.id) : [];
  const wordpress = connectors.find((c) => c.kind === "WORDPRESS");
  const firstRun = project ? await latestRunFor(project.id) : null;

  const step = !project ? 1 : wordpress?.status !== "CONNECTED" ? 2 : !firstRun ? 4 : 4;
  const done = { 1: Boolean(project), 2: wordpress?.status === "CONNECTED", 3: Boolean(project), 4: Boolean(firstRun) };

  const steps = [
    { n: 1, label: t("ob_step1") },
    { n: 2, label: t("ob_step2") },
    { n: 3, label: t("ob_step3") },
    { n: 4, label: t("ob_step4") },
  ];

  return (
    <>
      <TopBar t={t} locale={locale} pathname={pathname} title={t("onboarding")} />
      <div className="view">
        <Card
          title={t("onboarding")}
          sub={locale === "fa" ? `مرحله ${num(step, locale)} از ${num(4, locale)}` : `Step ${step} of 4`}
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
          wordpressConnected={wordpress?.status === "CONNECTED"}
          hasRun={Boolean(firstRun)}
          labels={{
            step1: t("ob_step1"),
            step2: t("ob_step2"),
            step4: t("ob_step4"),
            siteUrl: t("site_url"),
            username: t("username"),
            appPassword: t("app_password"),
            pageCap: t("page_cap"),
            crawlRate: t("crawl_rate"),
            next: t("ob_next"),
            skip: t("ob_skip"),
            scan: t("scan"),
            test: t("test_connection"),
            name: locale === "fa" ? "نام پروژه" : "Project name",
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
