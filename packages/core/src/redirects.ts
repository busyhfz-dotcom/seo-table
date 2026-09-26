/**
 * Redirect graph resolution.
 *
 * The crawler records each URL's own status and Location target. Chains are
 * derived here, after the crawl, by walking that graph — which also makes loop
 * detection exact rather than a guess based on hop count.
 */
export type RedirectNode = { normalizedUrl: string; statusCode: number; redirectTarget: string | null };

export type ResolvedRedirect = {
  /** Hops from this URL onwards, inclusive of the start, ending at the destination. */
  chain: string[];
  /** Where the chain ends. Equal to the start when the URL does not redirect. */
  finalUrl: string;
  loop: boolean;
};

export function resolveRedirects(nodes: RedirectNode[]): Map<string, ResolvedRedirect> {
  const byUrl = new Map(nodes.map((n) => [n.normalizedUrl, n]));
  const out = new Map<string, ResolvedRedirect>();

  for (const node of nodes) {
    if (!node.redirectTarget || node.statusCode < 300 || node.statusCode >= 400) {
      out.set(node.normalizedUrl, { chain: [], finalUrl: node.normalizedUrl, loop: false });
      continue;
    }

    const chain: string[] = [node.normalizedUrl];
    const seen = new Set<string>([node.normalizedUrl]);
    let cursor: string | null = node.redirectTarget;
    let loop = false;

    // Bounded by the node count, so a cycle can never spin here.
    while (cursor && chain.length <= nodes.length + 1) {
      if (seen.has(cursor)) {
        loop = true;
        chain.push(cursor);
        break;
      }
      chain.push(cursor);
      seen.add(cursor);
      const next: RedirectNode | undefined = byUrl.get(cursor);
      if (!next || next.statusCode < 300 || next.statusCode >= 400 || !next.redirectTarget) break;
      cursor = next.redirectTarget;
    }

    out.set(node.normalizedUrl, {
      chain,
      finalUrl: chain[chain.length - 1] ?? node.normalizedUrl,
      loop,
    });
  }

  return out;
}
