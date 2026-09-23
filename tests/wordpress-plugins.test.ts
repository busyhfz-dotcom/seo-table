/**
 * WordPress without the bridge: writes through the SEO plugin the site already
 * runs (Rank Math, SEOPress, All in One SEO), or through the post excerpt,
 * against the WordPress double's REST API and rendered pages.
 *
 * What must hold:
 *   - capabilities say exactly what will work on this site (Yoast: nothing);
 *   - every write is proven on the live page; one that does not show up, or
 *     that moves another field, is undone and reported;
 *   - fields the plugin's API would silently wipe are sent back unchanged;
 *   - rollback clears the plugin's value when that brings the old page back,
 *     instead of freezing the old rendered text into the plugin.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, connectors, db, fixProposals, organizations, projects, purgeOrganization } from "@seo/db";
import { closeQueues, closeRedis, seal } from "@seo/core";
import { execute, rollback } from "@seo/pipeline";
import { wordpress } from "@seo/connectors";
import { FAKE_WP_CREDENTIALS, startFakeWordPress, type FakeSeoPlugin, type FakeWp } from "./fake-wordpress.js";

const sites: FakeWp[] = [];
async function site(seoPlugin?: FakeSeoPlugin, extra: { excerptAsDescription?: boolean } = {}) {
  const wp = await startFakeWordPress({ frontEnd: true, ...(seoPlugin ? { seoPlugin } : {}), ...extra });
  sites.push(wp);
  return { wp, client: wordpress({ siteUrl: wp.baseUrl, ...FAKE_WP_CREDENTIALS }) };
}

afterAll(async () => {
  await Promise.all(sites.map((s) => s.close()));
});

describe.each(["rankmath", "seopress", "aioseo"] as const)("%s", (plugin) => {
  let wp: FakeWp;
  let client: ReturnType<typeof wordpress>;
  const hello = () => `${wp.baseUrl}/2024/hello/`;

  beforeAll(async () => {
    ({ wp, client } = await site(plugin));
  });

  it("advertises the SEO fields its API can write", async () => {
    const caps = await client.capabilities();
    expect(caps.supportedActions).toEqual(expect.arrayContaining(["ALT_TEXT", "TITLE_REWRITE", "META_REWRITE", "CANONICAL_FIX", "ROBOTS_FIX"]));
    expect(caps.supportedActions).not.toContain("REDIRECT");
    expect(caps.notes.join(" ")).toMatch(/own REST API/);
  });

  it("writes the title, proves it on the page, and reports the rendered value it replaced", async () => {
    expect(await client.read!({ url: hello(), field: "title" })).toBe("Hello - Fake WP");
    const res = await client.write!({ url: hello(), field: "title", before: "Hello - Fake WP", after: "Hello, runners" });
    expect(res).toMatchObject({ ok: true, previous: "Hello - Fake WP", applied: "Hello, runners" });
    expect(await client.read!({ url: hello(), field: "title" })).toBe("Hello, runners");
  });

  it("changing the description leaves the title alone", async () => {
    const res = await client.write!({ url: hello(), field: "meta_description", before: null, after: "A shorter description." });
    expect(res).toMatchObject({ ok: true, applied: "A shorter description." });
    expect(await client.read!({ url: hello(), field: "title" })).toBe("Hello, runners");
  });

  it("robots and canonical", async () => {
    expect(await client.write!({ url: hello(), field: "meta_robots", before: null, after: "noindex, follow" })).toMatchObject({ ok: true });
    expect(await client.read!({ url: hello(), field: "meta_robots" })).toMatch(/^noindex, follow/);
    expect(await client.write!({ url: hello(), field: "meta_robots", before: null, after: "index, follow" })).toMatchObject({ ok: true });
    const canonical = `${wp.baseUrl}/2024/hello/`;
    expect(await client.write!({ url: hello(), field: "canonical", before: null, after: canonical })).toMatchObject({ ok: true });
  });

  it("a restore clears the plugin's value when that brings back the old page", async () => {
    const res = await client.write!({ url: hello(), field: "title", before: "Hello, runners", after: "Hello - Fake WP", intent: "restore" });
    expect(res).toMatchObject({ ok: true, applied: "Hello - Fake WP" });
    const stored = wp.plugin.get(21) ?? {};
    // No frozen copy of the default: the plugin's own template renders it again.
    expect(stored.rank_math_title ?? stored._seopress_titles_title ?? stored.title ?? null).toBeFalsy();
  });

  it("undoes and reports a write the page does not show", async () => {
    wp.knobs.themeOverridesTitle = true;
    try {
      const res = await client.write!({ url: hello(), field: "title", before: null, after: "Never visible" });
      expect(res).toMatchObject({ ok: false, code: "not_visible_on_page" });
      const stored = wp.plugin.get(21) ?? {};
      expect([stored.rank_math_title, stored._seopress_titles_title, stored.title]).not.toContain("Never visible");
    } finally {
      wp.knobs.themeOverridesTitle = false;
    }
  });

  it("the front page cannot be resolved without the bridge", async () => {
    expect(await client.write!({ url: `${wp.baseUrl}/`, field: "title", before: null, after: "x" })).toMatchObject({ ok: false, code: "home_page_unsupported" });
  });
});

describe("All in One SEO's wipe-on-omit update", () => {
  it("sends back the Open Graph and title fields it would otherwise null", async () => {
    const { wp, client } = await site("aioseo");
    wp.plugin.set(21, { title: "Kept title", og_title: "Kept OG", twitter_description: "Kept tweet" });
    expect(await client.write!({ url: `${wp.baseUrl}/2024/hello/`, field: "meta_description", before: null, after: "New description" })).toMatchObject({ ok: true });
    expect(wp.plugin.get(21)).toMatchObject({ title: "Kept title", og_title: "Kept OG", twitter_description: "Kept tweet", description: "New description" });
  });
});

describe("Yoast", () => {
  it("is honest that nothing SEO can be written", async () => {
    const { wp, client } = await site("yoast");
    const caps = await client.capabilities();
    expect(caps.supportedActions).toEqual(["ALT_TEXT"]);
    expect(caps.notes.join(" ")).toMatch(/Yoast has no API/);
    expect(await client.write!({ url: `${wp.baseUrl}/2024/hello/`, field: "title", before: null, after: "x" })).toMatchObject({ ok: false, code: "unsupported_field" });
    expect(wp.writes).toHaveLength(0);
  });
});

describe("the excerpt as meta description", () => {
  it("is used only when the site renders excerpts as descriptions", async () => {
    const plain = await site(undefined);
    expect((await plain.client.capabilities()).supportedActions).toEqual(["ALT_TEXT"]);

    const { wp, client } = await site(undefined, { excerptAsDescription: true });
    const caps = await client.capabilities();
    expect(caps.supportedActions).toEqual(["ALT_TEXT", "META_REWRITE"]);
    expect(caps.supportedActions).not.toContain("TITLE_REWRITE");

    const res = await client.write!({ url: `${wp.baseUrl}/2024/hello/`, field: "meta_description", before: "A short hello from the blog.", after: "Hello again." });
    expect(res).toMatchObject({ ok: true, previous: "A short hello from the blog.", applied: "Hello again." });
    expect(wp.posts.find((p) => p.id === 21)!.excerpt).toBe("Hello again.");
    // A page whose description does not come from its excerpt is left alone.
    expect(await client.write!({ url: `${wp.baseUrl}/about/`, field: "meta_description", before: null, after: "x" })).toMatchObject({
      ok: false,
      code: "description_not_from_excerpt",
    });
    expect(await client.write!({ url: `${wp.baseUrl}/2024/hello/`, field: "title", before: null, after: "x" })).toMatchObject({ ok: false, code: "unsupported_field" });
  });
});

describe("apply and rollback through Rank Math", () => {
  let orgId: string;

  afterEach(async () => {
    if (orgId) await purgeOrganization(orgId);
  });
  afterAll(async () => {
    await closeQueues();
    await closeRedis();
    await closeDb();
  });

  it("rolls back to the plugin's default instead of a frozen copy", async () => {
    const { wp } = await site("rankmath");
    orgId = (await db.insert(organizations).values({ name: "RM org", slug: `rm-${Date.now()}` }).returning())[0]!.id;
    const projectId = (await db.insert(projects).values({ orgId, name: "RM", baseUrl: wp.baseUrl }).returning())[0]!.id;
    const sealed = seal(JSON.stringify({ siteUrl: wp.baseUrl, ...FAKE_WP_CREDENTIALS }));
    await db.insert(connectors).values({ projectId, kind: "WORDPRESS", status: "CONNECTED", secretCipher: sealed.cipher, secretIv: sealed.iv, secretTag: sealed.tag });
    const url = `${wp.baseUrl}/2024/hello/`;
    wp.plugin.set(21, { rank_math_description: "An overly long description that the scan wanted trimmed down." });
    const p = (
      await db
        .insert(fixProposals)
        .values({
          projectId,
          ruleId: "rule.meta.length",
          action: "META_REWRITE",
          risk: "LOW",
          title: "Trim",
          targetCount: 1,
          changes: [{ url, field: "meta_description", before: "An overly long description that the scan wanted trimmed down.", after: "A trimmed description." }],
        })
        .returning()
    )[0]!;
    await execute({ proposalId: p.id, dryRun: true, actor: { type: "USER", id: "u" } });
    const out = await execute({ proposalId: p.id, dryRun: false, actor: { type: "USER", id: "u" } });
    expect(out).toMatchObject({ status: "APPLIED", applied: 1 });
    expect(wp.plugin.get(21)?.rank_math_description).toBe("A trimmed description.");

    const undo = await rollback({ executionId: out.executionId, actor: { type: "USER", id: "u" } });
    expect(undo).toMatchObject({ status: "ROLLED_BACK", failed: 0 });
    // The original was an explicit value, so clearing did not bring it back and it was written again.
    expect(wp.plugin.get(21)?.rank_math_description).toBe("An overly long description that the scan wanted trimmed down.");
  });
});
