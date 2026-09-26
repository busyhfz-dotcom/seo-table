/**
 * Platform detection against sites served over real HTTP.
 *
 * What must hold: every answer comes from a signal the site actually sends
 * (headers, generator meta, asset paths, plugin comments, REST namespaces),
 * redirects are followed hop by hop, and a site with no signal is "custom".
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { detectPlatform } from "@seo/connectors";
import { detectCdn, detectCms, detectSeoPlugin } from "../packages/connectors/src/platform.js";

const servers: Server[] = [];
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
afterAll(() => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))));

const h = (init: Record<string, string>) => new Headers(init);

describe("detectPlatform over HTTP", () => {
  it("WordPress behind Cloudflare with Rank Math, version from the feed", async () => {
    const base = await serve((req, res) => {
      if (req.url === "/") {
        res.writeHead(301, { location: "/home/" });
        return res.end();
      }
      if (req.url === "/home/") {
        res.writeHead(200, { "content-type": "text/html", server: "cloudflare", "cf-ray": "8a1b2c3d4e5f-FRA", link: '<https://x/wp-json/>; rel="https://api.w.org/"' });
        return res.end('<html><head><!-- Search Engine Optimization by Rank Math - https://rankmath.com/ --><link rel="stylesheet" href="/wp-content/themes/a/style.css"></head></html>');
      }
      if (req.url === "/wp-json/") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ namespaces: ["oembed/1.0", "wp/v2", "rankmath/v1", "wc/v3"] }));
      }
      if (req.url === "/feed/") {
        res.writeHead(200, { "content-type": "application/rss+xml" });
        return res.end("<rss><channel><generator>https://wordpress.org/?v=6.6.2</generator></channel></rss>");
      }
      res.writeHead(404).end();
    });
    const p = await detectPlatform(`${base}/`);
    expect(p).toMatchObject({ cms: "wordpress", cmsVersion: "6.6.2", seoPlugin: "rankmath", cdn: "cloudflare", server: "cloudflare", wpNamespaces: ["wp/v2", "rankmath/v1"] });
    expect(Date.parse(p.detectedAt)).not.toBeNaN();
  });

  it("WordPress with the generator meta and Yoast's comment", async () => {
    const base = await serve((req, res) => {
      res.writeHead(req.url === "/" ? 200 : 404, { "content-type": "text/html", server: "nginx" });
      res.end(req.url === "/" ? '<meta name="generator" content="WordPress 6.5.1"><!-- This site is optimized with the Yoast SEO plugin v22.1 -->' : "");
    });
    expect(await detectPlatform(base)).toMatchObject({ cms: "wordpress", cmsVersion: "6.5.1", seoPlugin: "yoast", cdn: null, server: "nginx" });
  });

  it("a site with no signal is custom", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Hand made</title></head></html>");
    });
    expect(await detectPlatform(base)).toMatchObject({ cms: "custom", cmsVersion: null, seoPlugin: null, cdn: null });
  });

  it("an unreachable site is reported, not guessed", async () => {
    await expect(detectPlatform("http://127.0.0.1:1/")).rejects.toMatchObject({ code: "site_unreachable" });
  });
});

describe("signals", () => {
  it.each([
    [{ "x-shopid": "1" }, "", "shopify"],
    [{}, '<script src="https://cdn.shopify.com/s/files/x.js"></script>', "shopify"],
    [{ "x-wix-request-id": "1" }, "", "wix"],
    [{}, '<meta name="generator" content="Squarespace">', "squarespace"],
    [{}, '<html data-wf-site="abc" data-wf-page="def">', "webflow"],
    [{}, '<meta name="generator" content="Joomla! - Open Source Content Management">', "joomla"],
    [{ "x-generator": "Drupal 10 (https://www.drupal.org)" }, "", "drupal"],
    [{}, '<script type="text/x-magento-init">{}</script>', "magento"],
    [{ "x-powered-by": "Next.js" }, "", "nextjs"],
    [{}, '<script id="__NEXT_DATA__" type="application/json">{}</script>', "nextjs"],
    [{}, '<script>window.__NUXT__={}</script><script src="/_nuxt/app.js"></script>', "nuxt"],
  ] as const)("%j %s → %s", (headers, html, cms) => {
    expect(detectCms(html, h(headers)).cms).toBe(cms);
  });

  it("versions come from the generator only", () => {
    expect(detectCms('<meta name="generator" content="Drupal 10 (https://www.drupal.org)">', h({}))).toEqual({ cms: "drupal", version: "10" });
    expect(detectCms('<meta name="generator" content="Joomla! 4.2">', h({}))).toEqual({ cms: "joomla", version: "4.2" });
  });

  it.each([
    [{ "cf-ray": "x" }, "cloudflare"],
    [{ server: "ArvanCloud" }, "arvancloud"],
    [{ "x-fastly-request-id": "x" }, "fastly"],
    [{ "x-amz-cf-id": "x" }, "cloudfront"],
    [{ server: "AkamaiGHost" }, "akamai"],
    [{ "x-vercel-id": "x" }, "vercel"],
    [{ "x-nf-request-id": "x" }, "netlify"],
    [{ server: "BunnyCDN-DE1" }, "bunnycdn"],
    [{ "x-sucuri-id": "x" }, "sucuri"],
    [{ server: "Apache" }, null],
  ] as const)("CDN %j → %s", (headers, cdn) => {
    expect(detectCdn(h(headers))).toBe(cdn);
  });

  it("SEO plugins from comments or REST namespaces", () => {
    expect(detectSeoPlugin("<!-- All in One SEO 4.5 -->", [])).toBe("aioseo");
    expect(detectSeoPlugin("", ["seopress/v1"])).toBe("seopress");
    expect(detectSeoPlugin("", ["wp/v2"])).toBeNull();
  });
});
