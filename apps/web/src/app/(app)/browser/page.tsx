import { can } from "@seo/core";
import { TopBar } from "../../../components/shell";
import { pageContext } from "../../../lib/page";
import { BrowserScreen } from "./browser-screen";
import { BROWSER_KEYS, type BrowserStrings } from "./keys";

export const dynamic = "force-dynamic";

/**
 * A real browser, running on the worker, drawn inside the panel: the site can
 * be used as a visitor sees it (and as a phone sees it) without leaving the
 * console, and Inspect reads what a crawler gets from the rendered page.
 *
 * `?url=` opens that address straight away; otherwise the address bar starts
 * at the chosen (or default) project's site and waits for the reader.
 */
export default async function BrowserPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { t, locale, session, project, requestedProjectId } = await pageContext();
  const params = await searchParams;
  const requested = typeof params.url === "string" ? params.url.trim().slice(0, 2048) : "";
  const strings = Object.fromEntries(BROWSER_KEYS.map((key) => [key, t(key)])) as BrowserStrings;

  return (
    <>
      <TopBar title={t("browser")} />
      <div className="view">
        <BrowserScreen
          locale={locale}
          strings={strings}
          initialUrl={requested || project?.baseUrl || ""}
          autoStart={Boolean(requested)}
          projectId={requestedProjectId}
          canBrowse={session.via === "session" && can(session.role, "scan:run")}
        />
      </div>
    </>
  );
}
