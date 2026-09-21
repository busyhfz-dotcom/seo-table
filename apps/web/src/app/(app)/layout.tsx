import { Nav } from "../../components/shell";
import { pageContext } from "../../lib/page";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { t, locale, pathname, counts } = await pageContext();
  return (
    <div className="shell">
      <Nav t={t} locale={locale} pathname={pathname} counts={counts} />
      <main>{children}</main>
    </div>
  );
}
