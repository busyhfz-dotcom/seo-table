/**
 * Link equity over the site's internal link graph — the original PageRank
 * formulation, run on our own crawl. It is an estimate of how the site's own
 * links distribute importance, NOT Google's PageRank (which also counts links
 * from other sites and many signals we cannot see).
 *
 *   PR(p) = (1 − d)/N + d · ( Σ_{q → p} PR(q)/out(q)  +  Σ_{dangling q} PR(q)/N )
 *
 * with damping d = 0.85, N pages, iterated until the total change is below
 * 1e-8 (or 100 rounds). Only followable links count (rel=nofollow is left
 * out), each distinct source→target pair once, self-links ignored. A page with
 * no outgoing links (dangling) spreads its rank evenly, so rank is conserved
 * and the values sum to 1. Scores are also given on a 0–100 scale relative to
 * the strongest page, which is what the panel shows.
 */
export type Graph = { nodes: string[]; edges: Map<string, Set<string>> };

export type PageRank = { rank: Map<string, number>; score: Map<string, number>; iterations: number };

export function pageRank(graph: Graph, opts: { damping?: number; maxIterations?: number; tolerance?: number } = {}): PageRank {
  const d = opts.damping ?? 0.85;
  const max = opts.maxIterations ?? 100;
  const tol = opts.tolerance ?? 1e-8;
  const n = graph.nodes.length;
  const rank = new Map<string, number>();
  if (n === 0) return { rank, score: new Map(), iterations: 0 };
  const index = new Map(graph.nodes.map((u, i) => [u, i]));
  const out: number[][] = graph.nodes.map((u) => [...(graph.edges.get(u) ?? [])].map((v) => index.get(v)).filter((v): v is number => v !== undefined && v !== index.get(u)));
  let pr = new Float64Array(n).fill(1 / n);
  let iterations = 0;
  for (; iterations < max; iterations++) {
    const next = new Float64Array(n).fill((1 - d) / n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      const targets = out[i]!;
      if (targets.length === 0) {
        dangling += pr[i]!;
        continue;
      }
      const share = (d * pr[i]!) / targets.length;
      for (const t of targets) next[t]! += share;
    }
    const spread = (d * dangling) / n;
    let delta = 0;
    for (let i = 0; i < n; i++) {
      next[i]! += spread;
      delta += Math.abs(next[i]! - pr[i]!);
    }
    pr = next;
    if (delta < tol) {
      iterations++;
      break;
    }
  }
  let top = 0;
  for (let i = 0; i < n; i++) top = Math.max(top, pr[i]!);
  const score = new Map<string, number>();
  graph.nodes.forEach((u, i) => {
    rank.set(u, pr[i]!);
    score.set(u, top ? Math.round((pr[i]! / top) * 1000) / 10 : 0);
  });
  return { rank, score, iterations };
}
