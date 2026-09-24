/**
 * What every SEO data screen's server page hands its client component: the
 * shared wording, the reader's permissions, and the links an empty or
 * not-configured state points to.
 */
import Link from "next/link";
import { can, type Permission } from "@seo/core";
import { SUPPORTED_COUNTRIES } from "@seo/seo-data";
import { TopBar } from "../components/shell";
import { Card, Empty } from "../components/ui";
import { Icon } from "../components/icons";
import { COMMON } from "./common-strings";
import { pageContext, withProject } from "./page";
import { countryName } from "./seo-labels";
import type { Locale } from "./i18n";

export async function screenContext() {
  const pc = await pageContext();
  const allowed = (p: Permission) => can(pc.session.role, p);
  const href = (path: string) => withProject(path, pc.requestedProjectId);
  return {
    ...pc,
    c: COMMON[pc.locale],
    allowed,
    href,
    links: {
      connectGsc: `${href("/connect")}#search-console`,
      integrations: allowed("integration:manage") ? "/settings?tab=integrations" : null,
      audit: href("/audit"),
      connect: href("/connect"),
    },
  };
}

/** The markets a keyword can be tracked in, named in the reader's language; Iran first. */
export function countryOptions(locale: Locale): Array<{ code: string; name: string }> {
  const list = SUPPORTED_COUNTRIES.map((code) => ({ code, name: countryName(code, locale) }));
  const [first, rest] = [list.filter((c) => c.code === "IR"), list.filter((c) => c.code !== "IR")];
  return [...first, ...rest.sort((a, b) => a.name.localeCompare(b.name, locale))];
}

/** A screen that needs a project, before any exists. */
export function NoProject({ title, text, action }: { title: string; text: string; action: string }) {
  return (
    <>
      <TopBar title={title} />
      <div className="view">
        <Card title={title}>
          <Empty icon="rocket">
            <p style={{ marginBottom: 12 }}>{text}</p>
            <Link className="btn primary" href="/onboarding?new=1">
              <Icon name="plus" />
              {action}
            </Link>
          </Empty>
        </Card>
      </div>
    </>
  );
}
