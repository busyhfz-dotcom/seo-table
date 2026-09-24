/**
 * An Instagram page project end to end, against the Instagram API double.
 *
 * What must hold: without an Instagram app on the server everything says
 * not_configured and shows no data; the OAuth state binds the round trip to
 * the person who started it; tokens are sealed, refreshed before they expire,
 * and never returned; the audit's profile findings are manual with text to
 * paste (the API cannot edit a profile); competitors are never scraped
 * (Business Discovery or `unsupported`); publishing goes container → status →
 * publish, with alt text, once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  and,
  closeDb,
  db,
  eq,
  fixProposals,
  memberships,
  notifications,
  organizations,
  projects,
  purgeOrganization,
  scheduledPosts,
  socialAccounts,
  socialMetricsDaily,
  socialPosts,
  users,
} from "@seo/db";
import { closeQueues, closeRedis, hashPassword, hashToken, redisCommand, resetEnvCache, sealJson } from "@seo/core";
import { setSocialEndpoints } from "@seo/connectors";
import { createState, planner, runSocialSyncJob, socialAlerts } from "@seo/social";
import { fakeInstagram, type IgMediaFixture } from "./fake-social.js";

const jar = new Map<string, string>();
let requestHeaders = new Headers();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => requestHeaders,
}));

const { login } = await import("../apps/web/src/lib/auth");
const projectsRoute = await import("../apps/web/src/app/api/projects/route");
const socialRoute = await import("../apps/web/src/app/api/projects/[id]/social/route");
const startRoute = await import("../apps/web/src/app/api/oauth/instagram/start/route");
const callbackRoute = await import("../apps/web/src/app/api/oauth/instagram/callback/route");
const auditRoute = await import("../apps/web/src/app/api/projects/[id]/social/audit/route");
const analyticsRoute = await import("../apps/web/src/app/api/projects/[id]/social/analytics/route");
const competitorsRoute = await import("../apps/web/src/app/api/projects/[id]/social/competitors/route");
const refreshRoute = await import("../apps/web/src/app/api/projects/[id]/social/competitors/refresh/route");
const plannerRoute = await import("../apps/web/src/app/api/projects/[id]/social/planner/route");
const decisionRoute = await import("../apps/web/src/app/api/projects/[id]/social/planner/[postId]/decision/route");

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
function call(fn: Handler, method: string, path: string, opts: { body?: unknown; params?: Record<string, string> } = {}) {
  const headers = new Headers({ host: "app.example", "sec-fetch-site": "same-origin" });
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`);
  if (cookie.length) headers.set("cookie", cookie.join("; "));
  const req = new NextRequest(new URL(path, "http://app.example"), {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return fn(req, { params: Promise.resolve(opts.params ?? {}) });
}

const stamp = Date.now();
const password = "correct horse battery staple";
const admin = `s1-ig-admin-${stamp}@example.test`;
const other = `s1-ig-other-${stamp}@example.test`;
let orgId: string;
let projectId: string;
let ig: Awaited<ReturnType<typeof fakeInstagram>>;
const userIds: string[] = [];
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const p = (extra: Record<string, string> = {}) => ({ params: { id: projectId, ...extra } });
const DAY = 86_400_000;
const saved = { META_APP_ID: process.env.META_APP_ID, META_APP_SECRET: process.env.META_APP_SECRET, APP_URL: process.env.APP_URL };

async function signIn(email: string) {
  jar.clear();
  requestHeaders = new Headers({ "x-real-ip": "203.0.113.62" });
  expect((await login(email, password)).ok).toBe(true);
}

function media(now: number): IgMediaFixture[] {
  return Array.from({ length: 5 }, (_, i) => ({
    id: `1800000000000000${i}`,
    caption: `Our latte art ${i === 0 ? "" : "#coffee #latte"}`,
    media_type: i === 1 ? ("VIDEO" as const) : ("IMAGE" as const),
    timestamp: new Date(now - (i + 1) * 3 * DAY).toISOString().replace(/\.\d{3}Z$/, "+0000"),
    like_count: 100 + i,
    comments_count: 5,
    alt_text: i === 0 ? "A latte with a heart" : null,
    insights: { reach: 1000, views: 3000, likes: 100 + i, comments: 5, shares: 3, saved: 7, total_interactions: 115 + i },
  }));
}

beforeAll(async () => {
  ig = await fakeInstagram({ media: media(Date.now()) });
  setSocialEndpoints({ instagramGraph: ig.url, instagramApi: ig.url, instagramAuthorize: "https://www.instagram.com/oauth/authorize" });
  planner.timing.pollMs = 1;
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  process.env.APP_URL = "https://panel.example";
  resetEnvCache();

  orgId = (await db.insert(organizations).values({ name: "S1 ig", slug: `s1-ig-${stamp}` }).returning())[0]!.id;
  for (const email of [admin, other]) {
    const id = (await db.insert(users).values({ email, passwordHash: await hashPassword(password) }).returning())[0]!.id;
    userIds.push(id);
    await db.insert(memberships).values({ userId: id, orgId, role: "ADMIN" });
  }
});

beforeEach(async () => {
  const redis = redisCommand();
  await redis.del(...[admin, other].map((e) => `loginfail:${hashToken(e)}`));
  const keys = await redis.keys("rls:auth:203.0.113.62*");
  if (keys.length) await redis.del(...keys);
});

afterAll(async () => {
  setSocialEndpoints();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
  await ig.close();
  await purgeOrganization(orgId);
  for (const id of userIds) await db.delete(users).where(eq(users.id, id));
  await closeQueues();
  await closeRedis();
  await closeDb();
});

function useApp() {
  process.env.META_APP_ID = ig.knobs.appId;
  process.env.META_APP_SECRET = ig.knobs.appSecret;
  resetEnvCache();
}

describe("an Instagram project", () => {
  it("says not_configured, and shows nothing, without an Instagram app", async () => {
    await signIn(admin);
    const created = await json(await call(projectsRoute.POST, "POST", "/api/projects", { body: { name: "Cafe Roya", kind: "INSTAGRAM" } }));
    projectId = created.project.id;
    expect(created.project.baseUrl).toBe("https://www.instagram.com/");
    const view = await json(await call(socialRoute.GET, "GET", "/x", p()));
    expect(view).toMatchObject({ platform: "INSTAGRAM", instagramConfigured: false, account: { connected: false, followers: null } });
    expect(view.capabilities.editProfile).toBe(false);
    const res = await call(startRoute.GET, "GET", `/api/oauth/instagram/start?project=${projectId}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/social?project=${projectId}&instagram=error&reason=not_configured`);
    const analytics = await call(analyticsRoute.GET, "GET", "/x", p());
    expect((await json(analytics)).followers.series).toEqual([]);
  });

  it("sends the owner to Instagram's consent screen with a signed state and the four scopes", async () => {
    useApp();
    await signIn(admin);
    const res = await call(startRoute.GET, "GET", `/api/oauth/instagram/start?project=${projectId}`);
    const url = new URL(res.headers.get("location")!);
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(ig.knobs.appId);
    expect(url.searchParams.get("redirect_uri")).toBe("https://panel.example/api/oauth/instagram/callback");
    expect(url.searchParams.get("scope")!.split(",")).toEqual([
      "instagram_business_basic",
      "instagram_business_content_publish",
      "instagram_business_manage_insights",
      "instagram_business_manage_comments",
    ]);
    expect(url.searchParams.get("state")).toMatch(/^[\w-]+\.[\w-]+$/);
  });

  it("refuses a callback whose state belongs to someone else, or was tampered with", async () => {
    await signIn(other);
    const foreign = createState({ userId: userIds[0]!, orgId, projectId });
    let res = await call(callbackRoute.GET, "GET", `/api/oauth/instagram/callback?code=${ig.knobs.code}&state=${foreign}`);
    expect(res.headers.get("location")).toBe("/social?instagram=error&reason=state_invalid");
    await signIn(admin);
    const tampered = createState({ userId: userIds[0]!, orgId, projectId }).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    res = await call(callbackRoute.GET, "GET", `/api/oauth/instagram/callback?code=${ig.knobs.code}&state=${tampered}`);
    expect(res.headers.get("location")).toBe("/social?instagram=error&reason=state_invalid");
    res = await call(callbackRoute.GET, "GET", `/api/oauth/instagram/callback?error=access_denied&state=${createState({ userId: userIds[0]!, orgId, projectId })}`);
    expect(res.headers.get("location")).toBe(`/social?project=${projectId}&instagram=error&reason=access_denied`);
    expect((await db.select().from(socialAccounts).where(eq(socialAccounts.projectId, projectId)))[0]!.secretCipher).toBeNull();
  });

  it("connects: code → short → long-lived token, profile stored, token sealed and never returned", async () => {
    await signIn(admin);
    const state = createState({ userId: userIds[0]!, orgId, projectId });
    const res = await call(callbackRoute.GET, "GET", `/api/oauth/instagram/callback?code=${ig.knobs.code}%23_&state=${state}`);
    expect(res.headers.get("location")).toBe(`/social?project=${projectId}&instagram=connected`);
    const row = (await db.select().from(socialAccounts).where(eq(socialAccounts.projectId, projectId)))[0]!;
    expect(row).toMatchObject({ status: "CONNECTED", externalId: ig.knobs.userId, username: "cafe.roya", followers: 5200 });
    expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * DAY);
    expect(row.secretCipher).not.toContain(ig.knobs.token);
    const view = await json(await call(socialRoute.GET, "GET", "/x", p()));
    expect(JSON.stringify(view)).not.toContain(ig.knobs.token);
    expect(view.account.scopes).toContain("instagram_business_content_publish");
    expect((await db.select().from(projects).where(eq(projects.id, projectId)))[0]!.baseUrl).toBe("https://www.instagram.com/cafe.roya/");
  });

  it("syncs media across pages with insights and account totals", async () => {
    await db.update(socialAccounts).set({ settings: { keywords: ["specialty coffee"], cta: "Order via DM 👇" } }).where(eq(socialAccounts.projectId, projectId));
    const out = await runSocialSyncJob({ projectId, trigger: "MANUAL", requestedBy: userIds[0]!, correlationId: "t" });
    expect(out.sync).toMatchObject({ ok: true, posts: 5, warnings: [] });
    const posts = await db.select().from(socialPosts).where(eq(socialPosts.projectId, projectId));
    expect(posts).toHaveLength(5);
    const reel = posts.find((x) => x.type === "reel")!;
    expect(reel.metrics).toMatchObject({ reach: 1000, views: 3000, interactions: 116, saves: 7 });
    expect(posts.find((x) => x.externalId.endsWith("0"))!.altTexts).toEqual(["A latte with a heart"]);
    const daily = await db.select().from(socialMetricsDaily).where(eq(socialMetricsDaily.projectId, projectId));
    expect(daily.find((d) => d.reach !== null)).toMatchObject({ reach: 800, views: 2400, engagement: 130, source: "api" });
    expect(daily.find((d) => d.followers !== null)!.followers).toBe(5200);
  });

  it("audits the profile: name and bio are manual findings with text to paste; no proposal is made", async () => {
    await signIn(admin);
    const body = await json(await call(auditRoute.GET, "GET", "/x", p()));
    const byId = Object.fromEntries(body.findings.map((f: { ruleId: string }) => [f.ruleId, f]));
    expect(byId["social.ig.name_keyword"]).toMatchObject({ manual: true, suggestion: { field: "name", value: "Cafe Roya | specialty coffee" } });
    expect(byId["social.ig.bio_keyword"].suggestion.value).toContain("specialty coffee");
    expect(byId["social.ig.bio_keyword"].suggestion.value).toContain("Order via DM");
    expect(byId["social.ig.bio_link"]).toMatchObject({ manual: true, severity: "WARNING" });
    expect(byId["social.ig.alt_text"].detail.en).toBe("1 of the last 4 images have alt text.");
    expect(await db.select().from(fixProposals).where(eq(fixProposals.projectId, projectId))).toHaveLength(0);
  });

  it("reports ER by reach and by followers with the formulas", async () => {
    await signIn(admin);
    const body = await json(await call(analyticsRoute.GET, "GET", "/x", p()));
    expect(body.engagement.averageErByReach).toBeCloseTo(11.7, 1);
    expect(body.engagement.averageErByFollowers).toBeCloseTo((117 / 5200) * 100, 1);
    expect(body.formulas.erByReach.fa).toMatch(/دسترسی/);
    expect(body.topPosts[0].interactions).toBe(119);
  });

  it("marks competitors unsupported rather than scraping instagram.com", async () => {
    await signIn(admin);
    await call(competitorsRoute.POST, "POST", "/x", { ...p(), body: { username: "https://www.instagram.com/rival.cafe/" } });
    const body = await json(await call(refreshRoute.POST, "POST", "/x", { ...p(), body: {} }));
    expect(body.competitors[0]).toMatchObject({ username: "rival.cafe", status: "unsupported", snapshot: null });
    expect(ig.received.every((r) => !/instagram\.com/.test(r.headers.host ?? ""))).toBe(true);
    ig.knobs.businessDiscovery = "ok";
    const again = await json(await call(refreshRoute.POST, "POST", "/x", { ...p(), body: {} }));
    expect(again.competitors[0]).toMatchObject({ status: "ok", snapshot: { source: "business_discovery", followers: 9100, avgInteractions: 128 } });
  });

  it("publishes an approved carousel with alt text: containers, status, publish — once", async () => {
    await signIn(admin);
    const bad = await call(plannerRoute.POST, "POST", "/x", {
      ...p(),
      body: { payload: { op: "post", format: "image", text: "x", media: [{ url: "https://cdn.example/a.png", type: "image" }] } },
    });
    expect((await json(bad)).error.details.problems).toContain("instagram_images_must_be_jpeg");
    const created = await json(
      await call(plannerRoute.POST, "POST", "/x", {
        ...p(),
        body: {
          payload: {
            op: "post",
            format: "carousel",
            text: "New menu #coffee",
            media: [
              { url: "https://cdn.example/one.jpg", type: "image", altText: "Iced latte on a table" },
              { url: "https://cdn.example/two.jpg", type: "image", altText: "Croissant" },
            ],
          },
          submit: true,
        },
      }),
    );
    const postId = created.post.id;
    await call(decisionRoute.POST, "POST", "/x", { ...p({ postId }), body: { decision: "approve" } });
    const out = await planner.publishPost(postId);
    expect(out.status).toBe("published");
    const children = [...ig.knobs.containers.values()].filter((c) => c.params.is_carousel_item === "true");
    expect(children.map((c) => c.params.alt_text)).toEqual(["Iced latte on a table", "Croissant"]);
    const parent = [...ig.knobs.containers.values()].find((c) => c.params.media_type === "CAROUSEL")!;
    expect(parent.params.caption).toBe("New menu #coffee");
    expect(ig.knobs.published).toHaveLength(1);
    const row = (await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, postId)))[0]!;
    expect(row.resultPermalink).toBe(`https://www.instagram.com/p/${row.resultExternalId}/`);
    expect(await planner.publishPost(postId)).toMatchObject({ status: "skipped" });
    expect(ig.knobs.published).toHaveLength(1);
  });

  it("refreshes a token close to expiry, and warns when it cannot", async () => {
    const soon = new Date(Date.now() + 10 * DAY);
    await db
      .update(socialAccounts)
      .set({ tokenExpiresAt: soon, tokenRefreshedAt: new Date(Date.now() - 50 * DAY) })
      .where(eq(socialAccounts.projectId, projectId));
    const before = ig.knobs.token;
    const out = await runSocialSyncJob({ projectId, trigger: "SCHEDULE", requestedBy: "scheduler", correlationId: "t" });
    expect(out.sync.tokenRefreshed).toBe(true);
    expect(ig.knobs.token).toBe(`${before}-r`);
    const row = (await db.select().from(socialAccounts).where(eq(socialAccounts.projectId, projectId)))[0]!;
    expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * DAY);

    // A token that cannot be refreshed any more: the owner is told to reconnect.
    const sealed = sealJson({ accessToken: "IGAA-revoked" });
    await db
      .update(socialAccounts)
      .set({ secretCipher: sealed.cipher, secretIv: sealed.iv, secretTag: sealed.tag, tokenExpiresAt: new Date(Date.now() + 3 * DAY), tokenRefreshedAt: new Date(Date.now() - 57 * DAY) })
      .where(eq(socialAccounts.projectId, projectId));
    const failed = await runSocialSyncJob({ projectId, trigger: "SCHEDULE", requestedBy: "scheduler", correlationId: "t" });
    expect(failed.sync).toMatchObject({ ok: false, reason: "invalid_token" });
    await socialAlerts.evaluateAfterSync(projectId);
    const note = await db.select().from(notifications).where(and(eq(notifications.projectId, projectId), eq(notifications.kind, "token_expiring")));
    expect(note).toHaveLength(1);
    expect(note[0]!.title.fa).toMatch(/اینستاگرام/);
  });

  it("alerts once on a follower drop", async () => {
    const day = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
    await db.delete(socialMetricsDaily).where(eq(socialMetricsDaily.projectId, projectId));
    await db.insert(socialMetricsDaily).values([
      { projectId, date: day(8), followers: 6000, source: "api" },
      { projectId, date: day(0), followers: 5200, source: "api" },
    ]);
    const first = await socialAlerts.evaluateAfterSync(projectId);
    expect(first.map((n) => n.kind)).toContain("follower_drop");
    const second = await socialAlerts.evaluateAfterSync(projectId);
    expect(second.map((n) => n.kind)).not.toContain("follower_drop");
  });
});
