import { notFound } from "next/navigation";
import { contentService } from "@seo/seo-data";
import { isAppError } from "@seo/core";
import { TopBar } from "../../../../components/shell";
import { listConnectors } from "../../../../lib/queries";
import { NoProject, screenContext } from "../../../../lib/screen";
import { CONTENT } from "../strings";
import { Editor, type EditorDoc } from "./editor";

export const dynamic = "force-dynamic";

/** The content editor for one document, with its live analysis and WordPress publishing. */
export default async function ContentEditorPage({ params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  const { t, locale, project, c, allowed, href } = await screenContext();
  if (!project) return <NoProject title={t("content")} text={c.no_project} action={c.add_site} />;
  let doc;
  try {
    doc = await contentService.getDocumentView(project.id, docId);
  } catch (err) {
    if (isAppError(err) && err.status === 404) notFound();
    throw err;
  }
  const wordpress = (await listConnectors(project.id)).some((x) => x.kind === "WORDPRESS" && x.status === "CONNECTED");
  const s = CONTENT[locale];
  // Dates cross to the client component as strings.
  const view = JSON.parse(JSON.stringify(doc)) as EditorDoc;
  return (
    <>
      <TopBar title={t("content")} />
      <div className="view">
        <Editor
          doc={view}
          s={s}
          c={c}
          ctx={{
            projectId: project.id,
            baseUrl: project.baseUrl,
            locale,
            canWrite: allowed("content:write"),
            canApprove: allowed("fix:approve_sensitive"),
            canRollback: allowed("fix:rollback"),
            wordpress,
            listHref: href("/content"),
            connectHref: href("/connect"),
          }}
        />
      </div>
    </>
  );
}
