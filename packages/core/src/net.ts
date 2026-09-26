/**
 * Outbound HTTP for anything that fetches a user-supplied URL (crawler, sitemap
 * and robots fetches, connectors).
 *
 * A project's base URL is chosen by a customer, and every page it links to or
 * redirects to is chosen by whoever runs that site. Without this module either
 * of them could point the worker at 169.254.169.254, the database, or anything
 * else on the private network, and read the answer back through snapshots.
 */
import dns, { type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import { BlockedAddress } from "./errors.js";

/**
 * An AppError, so the web layer answers 400 BLOCKED_ADDRESS without a special
 * case. The contract's lowercase `blocked_address` code is deliberately not used:
 * AppError codes are the stable API codes and this one already exists.
 */
export class BlockedAddressError extends BlockedAddress {
  constructor(
    readonly host: string,
    reason: string,
  ) {
    // The resolved address is left out on purpose: echoing it would let a
    // caller map internal DNS through error messages.
    super(`${host} is not a public address (${reason})`, { host });
  }
}

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
// Special-purpose ranges inside 2000::/3: IETF protocol assignments (Teredo
// among them), documentation, and 6to4, which can tunnel to a private IPv4.
for (const [net, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}
// Only global unicast is reachable; everything outside it (loopback, ULA,
// link-local, multicast, NAT64, discard) is refused without listing each one.
const GLOBAL_UNICAST = new BlockList();
GLOBAL_UNICAST.addSubnet("2000::", 3, "ipv6");

function privateNetworkAllowed(): boolean {
  return process.env.ALLOW_PRIVATE_NETWORK === "1";
}

/** Eight 16-bit groups, or null when the text is not an IPv6 address. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip;
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number) as [number, number, number, number];
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<number>(Math.max(0, fill)).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** The IPv4 address carried by an IPv4-mapped (::ffff:a.b.c.d) or -compatible (::a.b.c.d) address. */
function embeddedIPv4(ip: string): string | null {
  const g = ipv6Groups(ip);
  if (!g || g.slice(0, 5).some((x) => x !== 0)) return null;
  if (g[5] !== 0xffff && g[5] !== 0) return null;
  // ::0 and ::1 are the unspecified and loopback addresses, not embedded IPv4.
  if (g[5] === 0 && g[6] === 0) return null;
  const hi = g[6]!;
  const lo = g[7]!;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !BLOCKED.check(ip, "ipv4");
  if (family !== 6) return false;
  const v4 = embeddedIPv4(ip);
  if (v4) return isPublicAddress(v4);
  return GLOBAL_UNICAST.check(ip, "ipv6") && !BLOCKED.check(ip, "ipv6");
}

/** Resolve through the default export so every lookup here goes through one seam. */
function lookupAll(hostname: string, family?: number): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true, family: family ?? 0 }, (err, addresses) =>
      err ? reject(err) : resolve(addresses),
    );
  });
}

function checkAddresses(hostname: string, addresses: LookupAddress[]): void {
  if (addresses.length === 0) throw new BlockedAddressError(hostname, "no addresses");
  // One private answer is enough to refuse: the connection could use any of them.
  if (addresses.some((a) => !isPublicAddress(a.address))) {
    throw new BlockedAddressError(hostname, "resolves to a private or reserved address");
  }
}

export async function assertPublicUrl(url: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BlockedAddressError(url, "not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new BlockedAddressError(u.hostname || url, `unsupported scheme ${u.protocol}`);
  }
  if (privateNetworkAllowed()) return;

  // WHATWG URL has already turned decimal, octal and hex IPv4 forms
  // (http://2130706433/, http://0x7f.1/) into dotted quads.
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new BlockedAddressError(host, "private or reserved address");
    return;
  }
  checkAddresses(host, await lookupAll(host));
}

/**
 * Connect-time lookup. The socket connects to exactly the addresses checked
 * here, so a DNS answer that changes between assertPublicUrl and the connection
 * (rebinding) is caught on the answer that is actually used.
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
  lookupAll(hostname, family)
    .then((addresses) => {
      if (!privateNetworkAllowed()) checkAddresses(hostname, addresses);
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    })
    .catch((err: NodeJS.ErrnoException) => callback(err, "", 0));
};

const agent = new Agent({ connect: { lookup: guardedLookup, timeout: 10_000 } });

export type GuardedResponse = {
  status: number;
  headers: Headers;
  url: string;
  body: Buffer;
  truncated: boolean;
};

export type GuardedInit = RequestInit & { timeoutMs?: number; maxBytes?: number };

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export async function guardedFetch(url: string, init: GuardedInit = {}): Promise<GuardedResponse> {
  const { timeoutMs = 15_000, maxBytes = DEFAULT_MAX_BYTES, signal, ...rest } = init;
  await assertPublicUrl(url);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await undiciFetch(url, {
      ...(rest as UndiciRequestInit),
      // Callers see every hop, so each redirect target is checked like a first request.
      redirect: "manual",
      signal: controller.signal,
      dispatcher: agent,
    });

    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (total + value.byteLength > maxBytes) {
          chunks.push(Buffer.from(value.buffer, value.byteOffset, maxBytes - total));
          total = maxBytes;
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        total += value.byteLength;
      }
    }

    return {
      status: res.status,
      headers: res.headers as unknown as Headers,
      url: res.url || url,
      body: Buffer.concat(chunks, total),
      truncated,
    };
  } catch (err) {
    // undici reports connect failures as TypeError("fetch failed") with the real
    // reason in `cause`; a refused address must surface as itself.
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof BlockedAddressError) throw cause;
    if (timedOut) throw new Error(`Request to ${url} timed out after ${timeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
