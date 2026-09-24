"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "../../../components/icons";

const TOOLS = [
  { href: "/tools/schema", icon: "code", key: "t_schema" },
  { href: "/tools/links", icon: "link", key: "t_links" },
  { href: "/tools/robots", icon: "shield", key: "t_robots" },
  { href: "/tools/sitemap", icon: "map", key: "t_sitemap" },
] as const;

/** The technical tools' own tabs; the project in the address carries across. */
export function ToolsNav({ labels, projectId, label }: { labels: Record<(typeof TOOLS)[number]["key"], string>; projectId: string | null; label: string }) {
  const pathname = usePathname();
  const q = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
  return (
    <nav className="tabs" aria-label={label}>
      {TOOLS.map((t) => (
        <Link key={t.href} href={`${t.href}${q}`} className="tab" aria-selected={pathname === t.href} aria-current={pathname === t.href ? "page" : undefined}>
          <Icon name={t.icon} />
          <span>{labels[t.key]}</span>
        </Link>
      ))}
    </nav>
  );
}
