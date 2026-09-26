import { TopBar } from "../../../components/shell";
import { websiteOnly } from "../../../lib/page";
import { NoProject, screenContext } from "../../../lib/screen";
import { PAGESPEED } from "./strings";
import { PageSpeedScreen } from "./screen";

export const dynamic = "force-dynamic";

/**
 * Page speed and Core Web Vitals from PageSpeed Insights (free; a key only
 * raises the quota). Real-user field data decides pass/fail when Google has
 * it; a lab-only result is labelled as such.
 */
export default async function PageSpeedPage() {
  await websiteOnly();
  const { t, locale, project, c, allowed, links } = await screenContext();
  if (!project) return <NoProject title={t("pagespeed")} text={c.no_project} action={c.add_site} />;
  return (
    <>
      <TopBar title={t("pagespeed")} />
      <div className="view">
        <PageSpeedScreen
          s={PAGESPEED[locale]}
          c={c}
          ctx={{ projectId: project.id, baseUrl: project.baseUrl, locale, canRun: allowed("tracking:write"), integrations: links.integrations }}
        />
      </div>
    </>
  );
}
