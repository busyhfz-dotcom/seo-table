/**
 * Test DNS: hosts under .example.test resolve to 127.0.0.1, so a site URL
 * can carry a real-looking host name (which the edge keys rules by) while the
 * request lands on a local server. Everything else resolves normally.
 */
import dns from "node:dns";
import { vi } from "vitest";

/** Resolve the test zone's hosts to the local edge server, like DNS pointing at Cloudflare. */
export function routeTestHostsToLocalhost(): void {
  const real = dns.lookup.bind(dns);
  vi.spyOn(dns, "lookup").mockImplementation(((hostname: string, options: unknown, callback: unknown) => {
    if (hostname.endsWith(".example.test")) {
      const cb = (typeof options === "function" ? options : callback) as (e: null, a: unknown, f?: number) => void;
      const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
      return all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4);
    }
    return (real as (...args: unknown[]) => void)(hostname, options, callback);
  }) as unknown as typeof dns.lookup);
}

