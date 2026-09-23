/**
 * The SSRF policy for everything the remote browser loads.
 *
 * Two layers, because a page is code written by whoever runs the site:
 *  1. every request the page makes is intercepted (context.route) and its host
 *     checked with `assertPublicUrl`, so a blocked request fails fast and visibly;
 *  2. Chromium's only way out is a local forward proxy (proxy.ts) that resolves
 *     each host itself and connects to exactly the address it checked. Layer 1
 *     alone would let a DNS answer change between the check and Chromium's own
 *     lookup (rebinding), and anything interception misses would go straight out.
 */
import dns, { type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { assertPublicUrl, BlockedAddressError, isPublicAddress } from "@seo/core";

const CACHE_MS = 60_000;
const CACHE_MAX = 2_000;

function privateNetworkAllowed(): boolean {
  return process.env.ALLOW_PRIVATE_NETWORK === "1";
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** Per-host verdicts, remembered for a minute so a page with 200 requests costs one lookup per host. */
export class HostGuard {
  private readonly cache = new Map<string, { verdict: Verdict; until: number }>();

  async check(rawUrl: string): Promise<Verdict> {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return { ok: false, reason: "invalid URL" };
    }
    // WebSockets are checked like the HTTP request they start as.
    const scheme = u.protocol === "ws:" ? "http:" : u.protocol === "wss:" ? "https:" : u.protocol;
    if (scheme !== "http:" && scheme !== "https:") return { ok: false, reason: `scheme ${u.protocol}` };

    const key = `${privateNetworkAllowed() ? "p" : "g"}:${u.hostname}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.until > now) return hit.verdict;

    let verdict: Verdict;
    try {
      await assertPublicUrl(`${scheme}//${u.host}/`);
      verdict = { ok: true };
    } catch (err) {
      if (!(err instanceof BlockedAddressError)) {
        // A DNS failure is not a verdict: the proxy resolves again and the
        // page shows the site as unreachable, which is the truth.
        return { ok: true };
      }
      verdict = { ok: false, reason: err.message };
    }
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(key, { verdict, until: now + CACHE_MS });
    return verdict;
  }
}

function lookupAll(hostname: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });
}

/**
 * The address the proxy connects to. Core's connect-time lookup is private to
 * its undici agent, and a raw socket needs the address itself; the rule is the
 * same one: every answer must be public, or none is used.
 */
export async function resolvePublic(host: string): Promise<{ address: string; family: number }> {
  const bare = host.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family) {
    if (!privateNetworkAllowed() && !isPublicAddress(bare)) {
      throw new BlockedAddressError(bare, "private or reserved address");
    }
    return { address: bare, family };
  }
  const addresses = await lookupAll(bare);
  if (addresses.length === 0) throw new BlockedAddressError(bare, "no addresses");
  if (!privateNetworkAllowed() && addresses.some((a) => !isPublicAddress(a.address))) {
    throw new BlockedAddressError(bare, "resolves to a private or reserved address");
  }
  return addresses[0]!;
}
