import { TopBar } from "../../../components/shell";
import { dataSources } from "../../../lib/seo-data";
import { NoProject, countryOptions, screenContext } from "../../../lib/screen";
import { KEYWORDS } from "./strings";
import { KeywordsScreen } from "./screen";

export const dynamic = "force-dynamic";

/**
 * Keywords and rankings. Positions, clicks and impressions come from Search
 * Console; live SERP ranks, volume and difficulty from DataForSEO when the
 * organization has set it up. Every figure carries its source, and a source
 * that is not connected leaves its columns empty with an explanation.
 */
export default async function KeywordsPage() {
  const { t, locale, project, c, allowed, links } = await screenContext();
  const s = KEYWORDS[locale];
  if (!project) return <NoProject title={t("keywords")} text={c.no_project} action={c.add_site} />;
  const sources = await dataSources(project);
  return (
    <>
      <TopBar title={t("keywords")} />
      <div className="view">
        <KeywordsScreen
          s={s}
          c={c}
          ctx={{
            projectId: project.id,
            baseUrl: project.baseUrl,
            locale,
            canWrite: allowed("tracking:write"),
            sources: { gsc: sources.gsc, dataforseo: sources.dataforseo },
            links,
            countries: countryOptions(locale),
          }}
        />
      </div>
    </>
  );
}
