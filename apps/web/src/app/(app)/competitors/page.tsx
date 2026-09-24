import { TopBar } from "../../../components/shell";
import { dataSources } from "../../../lib/seo-data";
import { NoProject, countryOptions, screenContext } from "../../../lib/screen";
import { COMPETITORS } from "./strings";
import { CompetitorsScreen } from "./screen";

export const dynamic = "force-dynamic";

/**
 * Competitors: sampled by the panel's own crawler and compared with the site by
 * the same method; keyword gap and backlinks come from DataForSEO only when the
 * organization has set it up.
 */
export default async function CompetitorsPage() {
  const { t, locale, project, c, allowed, links } = await screenContext();
  if (!project) return <NoProject title={t("competitors")} text={c.no_project} action={c.add_site} />;
  const sources = await dataSources(project);
  return (
    <>
      <TopBar title={t("competitors")} />
      <div className="view">
        <CompetitorsScreen
          s={COMPETITORS[locale]}
          c={c}
          ctx={{
            projectId: project.id,
            host: new URL(project.baseUrl).host,
            locale,
            canWrite: allowed("tracking:write"),
            dataforseo: sources.dataforseo,
            integrations: links.integrations,
            countries: countryOptions(locale),
          }}
        />
      </div>
    </>
  );
}
