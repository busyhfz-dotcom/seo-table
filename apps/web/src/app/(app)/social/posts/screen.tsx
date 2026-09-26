"use client";

/** Synced posts, newest or best first, with their figures and where each came from. */
import { useState } from "react";
import { Icon } from "../../../../components/icons";
import { Table, UserText } from "../../../../components/ui";
import { ErrorNote, Loading, useLoad } from "../../../../components/kit";
import { fmt } from "../../../../lib/dict";
import { dateTime, num } from "../../../../lib/format";
import type { CommonStrings } from "../../../../lib/common-strings";
import type { SocialStrings } from "../strings";
import type { PerPost } from "../api-types";
import { PostMetrics } from "../analytics/screen";
import { SourcePill, maybe, type SocialCtx } from "../parts";

type Page = { page: number; perPage: number; total: number; posts: Array<PerPost & { metricsAt: string | null }> };

export function SocialPostsScreen({ ctx, s, c }: { ctx: SocialCtx; s: SocialStrings; c: CommonStrings }) {
  const [sort, setSort] = useState<"recent" | "top">("recent");
  const [page, setPage] = useState(1);
  const data = useLoad<Page>(`/api/projects/${encodeURIComponent(ctx.projectId)}/social/posts?sort=${sort}&page=${page}&perPage=25`, ctx.locale);
  const L = ctx.locale;
  const d = data.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.perPage)) : 1;

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <p className="desc" style={{ maxWidth: 720 }}>
          {s.po_intro}
        </p>
        <div className="seg" role="group" aria-label={s.sort}>
          {(["recent", "top"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={sort === k}
              onClick={() => {
                setSort(k);
                setPage(1);
              }}
            >
              {k === "recent" ? s.sort_recent : s.sort_top}
            </button>
          ))}
        </div>
      </div>
      {data.error && !d ? (
        <ErrorNote message={data.error} onRetry={() => void data.reload()} c={c} />
      ) : !d ? (
        <Loading label={c.loading} rows={8} />
      ) : d.total === 0 ? (
        <section className="card">
          <div className="body">
            <div className="empty">
              <Icon name="list" />
              <div>{s.po_empty}</div>
            </div>
          </div>
        </section>
      ) : (
        <section className="card">
          <header>
            <h3>{fmt(s.total_posts, { n: num(d.total, L) })}</h3>
          </header>
          <Table head={[{ label: s.col_date }, { label: s.col_type }, { label: s.col_text }, { label: s.col_metrics }, { label: s.col_source }]}>
            {d.posts.map((p) => (
              <tr key={p.id}>
                <td style={{ whiteSpace: "nowrap" }}>{dateTime(p.publishedAt, L)}</td>
                <td>{maybe(s, `type_${p.type}`) ?? p.type}</td>
                <td className="cap-cell">
                  {p.caption ? <UserText className="clamp2">{p.caption}</UserText> : <span className="muted">{s.no_caption}</span>}
                  {p.permalink && (
                    <div>
                      <a href={p.permalink} target="_blank" rel="noreferrer noopener" className="lnk small">
                        <Icon name="external" />
                        {s.open_post}
                      </a>
                    </div>
                  )}
                </td>
                <td>
                  <PostMetrics p={p} ctx={ctx} s={s} />
                </td>
                <td>
                  <SourcePill source={p.source} platform={ctx.platform} s={s} />
                </td>
              </tr>
            ))}
          </Table>
          {pages > 1 && (
            <div className="body row" style={{ justifyContent: "space-between" }}>
              <button type="button" className="btn ghost sm" disabled={page <= 1 || data.loading} onClick={() => setPage(page - 1)}>
                {s.prev}
              </button>
              <span className="muted small">{fmt(s.page_of, { p: num(page, L), n: num(pages, L) })}</span>
              <button type="button" className="btn ghost sm" disabled={page >= pages || data.loading} onClick={() => setPage(page + 1)}>
                {s.next}
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}
