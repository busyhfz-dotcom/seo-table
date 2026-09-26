import dns from "node:dns";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BlockedAddressError, assertPublicUrl, guardedFetch, isPublicAddress } from "./net.js";
import { AppError } from "./errors.js";

/** vitest allows private targets globally; these tests need the production behaviour. */
function withoutPrivateNetwork() {
  const saved = process.env.ALLOW_PRIVATE_NETWORK;
  delete process.env.ALLOW_PRIVATE_NETWORK;
  return () => {
    if (saved === undefined) delete process.env.ALLOW_PRIVATE_NETWORK;
    else process.env.ALLOW_PRIVATE_NETWORK = saved;
  };
}

let server: Server;
let port = 0;
let hits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(Buffer.alloc(1024 * 1024, 97));
    } else if (req.url === "/stall") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      // never ends: the timeout has to cover the body, not just the headers
    } else if (req.url === "/redirect") {
      res.writeHead(302, { location: "/target" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isPublicAddress", () => {
  it.each([
    ["127.0.0.1", false],
    ["10.1.2.3", false],
    ["172.16.5.4", false],
    ["192.168.1.1", false],
    ["100.64.0.1", false],
    ["169.254.169.254", false],
    ["0.0.0.0", false],
    ["224.0.0.1", false],
    ["255.255.255.255", false],
    ["8.8.8.8", true],
    ["185.143.232.10", true],
    ["::1", false],
    ["::", false],
    ["fe80::1", false],
    ["fc00::1", false],
    ["fd12:3456::1", false],
    ["ff02::1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:7f00:1", false],
    ["::ffff:a9fe:a9fe", false],
    ["::127.0.0.1", false],
    ["64:ff9b::a00:1", false],
    ["2002:7f00:1::", false],
    ["2001:db8::1", false],
    ["::ffff:8.8.8.8", true],
    ["2606:4700:4700::1111", true],
    ["not-an-ip", false],
  ])("%s → %s", (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });
});

describe("assertPublicUrl", () => {
  it.each([
    "http://127.0.0.1/",
    "http://2130706433/", // decimal
    "http://0x7f.0.0.1/", // hex
    "http://0177.0.0.1/", // octal
    "http://127.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/",
  ])("refuses %s", async (url) => {
    const restore = withoutPrivateNetwork();
    try {
      const err = await assertPublicUrl(url).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BlockedAddressError);
      // An AppError, so the API answers 400 BLOCKED_ADDRESS by itself.
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(400);
      expect((err as AppError).code).toBe("BLOCKED_ADDRESS");
    } finally {
      restore();
    }
  });

  it("refuses non-http schemes even when private networks are allowed", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(assertPublicUrl("gopher://x/")).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("refuses a name when any one of its addresses is private", async () => {
    const restore = withoutPrivateNetwork();
    vi.spyOn(dns, "lookup").mockImplementation(((
      _host: string,
      _opts: unknown,
      cb: (err: null, addrs: Array<{ address: string; family: number }>) => void,
    ) => cb(null, [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ])) as unknown as typeof dns.lookup);
    try {
      await expect(assertPublicUrl("http://mixed.example/")).rejects.toBeInstanceOf(BlockedAddressError);
    } finally {
      restore();
    }
  });

  it("accepts a name that resolves only to public addresses", async () => {
    const restore = withoutPrivateNetwork();
    vi.spyOn(dns, "lookup").mockImplementation(((
      _host: string,
      _opts: unknown,
      cb: (err: null, addrs: Array<{ address: string; family: number }>) => void,
    ) => cb(null, [{ address: "93.184.216.34", family: 4 }])) as unknown as typeof dns.lookup);
    try {
      await expect(assertPublicUrl("https://public.example/")).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe("guardedFetch", () => {
  it("never connects to a private address", async () => {
    const restore = withoutPrivateNetwork();
    const before = hits;
    try {
      await expect(guardedFetch(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(BlockedAddressError);
      expect(hits).toBe(before);
    } finally {
      restore();
    }
  });

  it("checks the address actually connected to, so DNS rebinding is refused", async () => {
    const restore = withoutPrivateNetwork();
    const before = hits;
    let calls = 0;
    // First answer (the pre-flight check) is public; the connection-time answer is loopback.
    vi.spyOn(dns, "lookup").mockImplementation(((
      _host: string,
      _opts: unknown,
      cb: (err: null, addrs: Array<{ address: string; family: number }>) => void,
    ) => {
      calls++;
      cb(null, [{ address: calls === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }]);
    }) as unknown as typeof dns.lookup);
    try {
      await expect(guardedFetch(`http://rebind.example:${port}/`)).rejects.toBeInstanceOf(BlockedAddressError);
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(hits).toBe(before);
    } finally {
      restore();
    }
  });

  it("caps the body and says so", async () => {
    const res = await guardedFetch(`http://127.0.0.1:${port}/big`, { maxBytes: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1000);
    expect(res.truncated).toBe(true);
    const small = await guardedFetch(`http://127.0.0.1:${port}/`);
    expect(small.body.toString()).toBe("ok");
    expect(small.truncated).toBe(false);
  });

  it("times out while the body is still arriving", async () => {
    await expect(guardedFetch(`http://127.0.0.1:${port}/stall`, { timeoutMs: 300 })).rejects.toThrow(/timed out/);
  });

  it("returns redirects to the caller instead of following them", async () => {
    const res = await guardedFetch(`http://127.0.0.1:${port}/redirect`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/target");
  });
});
