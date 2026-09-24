import Link from "next/link";
import { Icon } from "../../../components/icons";
import { ToolFrame } from "./frame";

export const dynamic = "force-dynamic";

const CARDS = [
  { href: "/tools/schema", icon: "code", title: "t_schema", desc: "d_schema" },
  { href: "/tools/links", icon: "link", title: "t_links", desc: "d_links" },
  { href: "/tools/robots", icon: "shield", title: "t_robots", desc: "d_robots" },
  { href: "/tools/sitemap", icon: "map", title: "t_sitemap", desc: "d_sitemap" },
] as const;

/** The technical tools, each on its own page; this one introduces them. */
export default function ToolsPage() {
  return (
    <ToolFrame
      render={({ ctx, s }) => (
        <div className="grid g2">
          {CARDS.map((card) => (
            <section key={card.href} className="card tool-card">
              <div className="body stack">
                <div className="row">
                  <span className="mico">
                    <Icon name={card.icon} />
                  </span>
                  <h3>{s[card.title]}</h3>
                </div>
                <p className="desc">{s[card.desc]}</p>
                <div>
                  <Link className="btn primary" href={ctx.href(card.href)}>
                    {s.open_tool}
                    <Icon name={ctx.locale === "fa" ? "arrowL" : "arrowR"} />
                  </Link>
                </div>
              </div>
            </section>
          ))}
        </div>
      )}
    />
  );
}
