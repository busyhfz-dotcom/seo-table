/**
 * A Telegram channel project end to end, through the real route handlers,
 * PostgreSQL and Redis, against the Bot API and t.me preview doubles.
 *
 * What must hold: a bot token is stored only for a channel the bot can manage
 * and never comes back; every refusal names its reason; the preview's view
 * counts are read and labelled; the audit's title/description changes go
 * through the ordinary approval + dry run + apply + rollback pipeline; a
 * planned post is published once, only after a person approved it, and a post
 * whose outcome is unknown is never sent again.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  and,
  approvals,
  auditLog,
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
  schedules,
  socialAccounts,
  socialMetricsDaily,
  socialPosts,
  users,
} from "@seo/db";
import { closeQueues, closeRedis, hashPassword, hashToken, redisCommand, resetEnvCache, scanService } from "@seo/core";
import { setSocialEndpoints } from "@seo/connectors";
import { execute, rollback } from "@seo/pipeline";
import { planner, runSocialSyncJob, socialAccounts as accounts } from "@seo/social";
import { fakePreview, fakeTelegram, type PreviewPostFixture } from "./fake-social.js";

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
const telegramRoute = await import("../apps/web/src/app/api/projects/[id]/social/telegram/route");
const checkRoute = await import("../apps/web/src/app/api/projects/[id]/social/check/route");
const auditRoute = await import("../apps/web/src/app/api/projects/[id]/social/audit/route");
const analyticsRoute = await import("../apps/web/src/app/api/projects/[id]/social/analytics/route");
const postsRoute = await import("../apps/web/src/app/api/projects/[id]/social/posts/route");
const competitorsRoute = await import("../apps/web/src/app/api/projects/[id]/social/competitors/route");
const refreshRoute = await import("../apps/web/src/app/api/projects/[id]/social/competitors/refresh/route");
const plannerRoute = await import("../apps/web/src/app/api/projects/[id]/social/planner/route");
const decisionRoute = await import("../apps/web/src/app/api/projects/[id]/social/planner/[postId]/decision/route");
const publishNowRoute = await import("../apps/web/src/app/api/projects/[id]/social/planner/[postId]/publish-now/route");
const calendarRoute = await import("../apps/web/src/app/api/projects/[id]/social/planner/calendar/route");
const connectionRoute = await import("../apps/web/src/app/api/projects/[id]/social/connection/route");
const approvalRoute = await import("../apps/web/src/app/api/approvals/[id]/route");
const webhookRoute = await import("../apps/web/src/app/api/social/telegram/webhook/[accountId]/route");

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
function call(fn: Handler, method: string, path: string, opts: { body?: unknown; params?: Record<string, string>; locale?: string; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ host: "app.example", "sec-fetch-site": "same-origin", ...(opts.headers ?? {}) });
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`);
  if (opts.locale) cookie.push(`locale=${opts.locale}`);
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
const admin = `s1-tg-admin-${stamp}@example.test`;
const editor = `s1-tg-editor-${stamp}@example.test`;
let orgId: string;
let projectId: string;
let tg: Awaited<ReturnType<typeof fakeTelegram>>;
let preview: Awaited<ReturnType<typeof fakePreview>>;
const userIds: string[] = [];
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const p = (extra: Record<string, string> = {}) => ({ params: { id: projectId, ...extra } });
const DAY = 86_400_000;

async function signIn(email: string) {
  jar.clear();
  requestHeaders = new Headers({ "x-real-ip": "203.0.113.61" });
  expect((await login(email, password)).ok).toBe(true);
}

/** 24 posts over ~48 days: views fall hard in the most recent ten. */
function channelPosts(now: number): PreviewPostFixture[] {
  return Array.from({ length: 24 }, (_, i) => {
    const id = 100 + i;
    const age = (24 - i) * 2 * DAY + 3 * DAY;
    const recent = i >= 14;
    return {
      id,
      date: new Date(now - age),
      text: `Post ${id} about #coffee and #tehran ${"x".repeat(i % 3 === 0 ? 400 : 60)}`,
      views: recent ? "150" : `${(1 + (i % 3) / 10).toFixed(1)}K`,
      photo: i % 4 === 0,
    };
  });
}

beforeAll(async () => {
  tg = await fakeTelegram();
  preview = await fakePreview();
  setSocialEndpoints({ telegramApi: tg.url, telegramPreview: preview.url });
  planner.timing.pollMs = 1;
  preview.knobs.channels.set("roya_news", { title: "Roya News", description: "", subscribers: "1K", posts: channelPosts(Date.now()) });
  preview.knobs.channels.set("rival_channel", {
    title: "Rival",
    description: "Coffee news",
    subscribers: "12.4K",
    posts: [
      { id: 7, date: new Date(Date.now() - 2 * DAY), text: "a", views: "3.1K" },
      { id: 8, date: new Date(Date.now() - DAY), text: "b", views: "2.9K" },
    ],
  });

  orgId = (await db.insert(organizations).values({ name: "S1 tg", slug: `s1-tg-${stamp}` }).returning())[0]!.id;
  for (const [email, role] of [[admin, "ADMIN"], [editor, "EDITOR"]] as const) {
    const id = (await db.insert(users).values({ email, passwordHash: await hashPassword(password) }).returning())[0]!.id;
    userIds.push(id);
    await db.insert(memberships).values({ userId: id, orgId, role });
  }
});

beforeEach(async () => {
  const redis = redisCommand();
  await redis.del(...[admin, editor].map((e) => `loginfail:${hashToken(e)}`));
  const keys = await redis.keys("rls:auth:203.0.113.61*");
  if (keys.length) await redis.del(...keys);
});

afterAll(async () => {
  setSocialEndpoints();
  await tg.close();
  await preview.close();
  await purgeOrganization(orgId);
  for (const id of userIds) await db.delete(users).where(eq(users.id, id));
  await closeQueues();
  await closeRedis();
  await closeDb();
});

describe("a Telegram project", () => {
  it("is created with a daily sync, no website schedules, and cannot be crawled", async () => {
    await signIn(admin);
    const res = await call(projectsRoute.POST, "POST", "/api/projects", { body: { name: "Roya channel", kind: "TELEGRAM", handle: "@roya_news" } });
    expect(res.status).toBe(201);
    const { project } = await json(res);
    projectId = project.id;
    expect(project).toMatchObject({ kind: "TELEGRAM", baseUrl: "https://t.me/roya_news" });
    const kinds = (await db.select().from(schedules).where(eq(schedules.projectId, projectId))).map((s) => s.kind);
    expect(kinds).toEqual(["social_sync"]);
    await expect(scanService.createScan({ projectId, orgId, actor: { type: "USER", id: "u" } })).rejects.toMatchObject({ status: 400 });
    const view = await json(await call(socialRoute.GET, "GET", "/x", p()));
    expect(view).toMatchObject({ platform: "TELEGRAM", account: { status: "NOT_CONNECTED", connected: false } });
  });

  it.each([
    [{ token: "wrong" }, "invalid_token"],
    [{ chat: "@nope_channel" }, "chat_not_found"],
    [{ type: "supergroup" }, "not_a_channel"],
    [{ status: "member" }, "not_admin"],
    [{ rights: { can_post_messages: true, can_edit_messages: true, can_change_info: false } }, "missing_right:can_change_info"],
  ] as const)("refuses to connect %j with %s, storing nothing", async (setup, reason) => {
    const saved = { type: tg.knobs.chat.type, status: tg.knobs.status, rights: tg.knobs.rights };
    if ("type" in setup) tg.knobs.chat.type = setup.type;
    if ("status" in setup) tg.knobs.status = setup.status;
    if ("rights" in setup) tg.knobs.rights = { ...setup.rights };
    try {
      await signIn(admin);
      const botToken = "token" in setup ? "7000000009:AAHwrongTokenForTests_abcdefghijklmnop" : tg.knobs.token;
      const body = await json(
        await call(telegramRoute.POST, "POST", "/x", { ...p(), body: { botToken, channel: "chat" in setup ? setup.chat : "@roya_news" }, locale: "en" }),
      );
      expect(body).toMatchObject({ ok: false, reason });
      expect(body.reasonText.fa).toMatch(/[؀-ۿ]/);
      const row = await accounts.getAccount(projectId);
      expect(row!.secretCipher).toBeNull();
      expect(JSON.stringify(body)).not.toContain(botToken);
    } finally {
      Object.assign(tg.knobs.chat, { type: saved.type });
      tg.knobs.status = saved.status;
      tg.knobs.rights = saved.rights;
    }
  });

  it("an editor cannot connect; an admin connects and the token never comes back", async () => {
    await signIn(editor);
    expect((await call(telegramRoute.POST, "POST", "/x", { ...p(), body: { botToken: tg.knobs.token, channel: "https://t.me/roya_news" } })).status).toBe(403);
    await signIn(admin);
    const body = await json(await call(telegramRoute.POST, "POST", "/x", { ...p(), body: { botToken: tg.knobs.token, channel: "https://t.me/roya_news" } }));
    expect(body).toMatchObject({
      ok: true,
      account: { connected: true, externalId: "-1001234567890", username: "roya_news", followers: 1000, profile: { botUsername: "roya_panel_bot" } },
    });
    // APP_URL is http:// in tests, so updates are polled and any webhook is removed.
    expect(body.account.profile.updates.mode).toBe("polling");
    expect(tg.knobs.sent.some((s) => s.method === "deleteWebhook")).toBe(true);
    const all = JSON.stringify([body, await json(await call(socialRoute.GET, "GET", "/x", p()))]);
    expect(all).not.toContain(tg.knobs.token);
    const logRows = await db.select().from(auditLog).where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "social.connect")));
    expect(logRows).toHaveLength(1);
    expect(JSON.stringify(logRows)).not.toContain(tg.knobs.token);
    const check = await json(await call(checkRoute.POST, "POST", "/x", p()));
    expect(check.ok).toBe(true);
  });

  it("syncs members, posts from the public preview with their views, and polled channel posts", async () => {
    await accounts.updateSettings(projectId, { keywords: ["قهوه"], link: "https://roya.example/shop", cta: "سفارش در @roya_support" });
    tg.knobs.updates = [
      { update_id: 9001, channel_post: { message_id: 124, date: Math.floor(Date.now() / 1000), chat: { id: -1001234567890, type: "channel", username: "roya_news" }, text: "Fresh post #coffee", entities: [{ type: "bold" }] } },
    ];
    const out = await runSocialSyncJob({ projectId, trigger: "SCHEDULE", requestedBy: "scheduler", correlationId: "t" });
    expect(out.sync).toMatchObject({ ok: true, platform: "TELEGRAM" });
    const posts = await db.select().from(socialPosts).where(eq(socialPosts.projectId, projectId));
    expect(posts).toHaveLength(25);
    const p110 = posts.find((x) => x.externalId === "110")!;
    expect(p110).toMatchObject({ source: "public_preview", permalink: "https://t.me/roya_news/110", hashtags: ["coffee", "tehran"] });
    expect(p110.metrics.views).toBe(1100);
    // The polled post arrived through the API and is marked as formatted.
    expect(posts.find((x) => x.externalId === "124")).toMatchObject({ source: "api", features: { formatted: true } });
    const offset = (await accounts.getAccount(projectId))!.profile.updates?.offset;
    expect(offset).toBe(9002);
    const daily = await db.select().from(socialMetricsDaily).where(eq(socialMetricsDaily.projectId, projectId));
    expect(daily.map((d) => [d.source, d.followers]).sort()).toEqual([["api", 1000], ["public_preview", 1000]]);

    // The audit ran after the sync.
    expect(out.audit!.findings).toBeGreaterThan(0);
  });

  it("audits with fa/en text and suggestions, and queues title/description changes for approval", async () => {
    await signIn(admin);
    const body = await json(await call(auditRoute.GET, "GET", "/x", p()));
    const ids = body.findings.map((f: { ruleId: string }) => f.ruleId);
    expect(ids).toEqual(expect.arrayContaining(["social.tg.title_keyword", "social.tg.description_missing", "social.tg.pinned", "social.tg.view_rate"]));
    expect(body.score).toBeLessThan(100);
    const desc = body.findings.find((f: { ruleId: string }) => f.ruleId === "social.tg.description_missing");
    expect(desc).toMatchObject({ severity: "SERIOUS", manual: false, suggestion: { field: "description" } });
    expect(desc.suggestion.value).toContain("قهوه");
    expect(desc.suggestion.value).toContain("https://roya.example/shop");
    expect(desc.title.fa).toMatch(/[؀-ۿ]/);
    expect(desc.title.en).not.toMatch(/[؀-ۿ]/);
    expect(desc.proposal).toMatchObject({ action: "SOCIAL_DESCRIPTION", status: "AWAITING_APPROVAL", risk: "SENSITIVE" });
    const viewRate = body.findings.find((f: { ruleId: string }) => f.ruleId === "social.tg.view_rate");
    expect(viewRate.detail.en).toMatch(/below the 10 before/);

    // A second audit does not duplicate an open proposal.
    await call(auditRoute.POST, "POST", "/x", p());
    const open = await db.select().from(fixProposals).where(eq(fixProposals.projectId, projectId));
    expect(open.filter((x) => x.action === "SOCIAL_DESCRIPTION")).toHaveLength(1);
    expect(open.filter((x) => x.action === "SOCIAL_TITLE")).toHaveLength(1);
  });

  it("applies an approved description through the fix pipeline, and rolls it back", async () => {
    const proposal = (await db.select().from(fixProposals).where(and(eq(fixProposals.projectId, projectId), eq(fixProposals.action, "SOCIAL_DESCRIPTION"))))[0]!;
    // Not before approval, whoever asks.
    await expect(execute({ proposalId: proposal.id, dryRun: false, actor: { type: "USER", id: "x" } })).rejects.toThrow();
    await signIn(admin);
    expect((await call(approvalRoute.POST, "POST", "/x", { params: { id: proposal.id }, body: { decision: "approve" } })).status).toBe(200);
    const dry = await execute({ proposalId: proposal.id, dryRun: true, actor: { type: "USER", id: userIds[0]! } });
    expect(dry).toMatchObject({ applied: 1, failed: 0 });
    expect(tg.knobs.chat.description).toBe("");
    const live = await execute({ proposalId: proposal.id, dryRun: false, actor: { type: "USER", id: userIds[0]! } });
    expect(live).toMatchObject({ status: "APPLIED", applied: 1 });
    const after = (proposal.changes as Array<{ after: string }>)[0]!.after;
    expect(tg.knobs.chat.description).toBe(after);
    const undone = await rollback({ executionId: live.executionId, actor: { type: "USER", id: userIds[0]! } });
    expect(undone.status).toBe("ROLLED_BACK");
    expect(tg.knobs.chat.description).toBe("");
    expect((await db.select().from(approvals).where(eq(approvals.fixProposalId, proposal.id)))[0]!.decision).toBe("APPROVED");
  });

  it("reports analytics with formulas and sources, and lists posts by views", async () => {
    await signIn(admin);
    const from = new Date(Date.now() - 90 * DAY).toISOString().slice(0, 10);
    const body = await json(await call(analyticsRoute.GET, "GET", `/x?from=${from}`, p()));
    expect(body.platform).toBe("TELEGRAM");
    expect(body.followers.current).toBe(1000);
    expect(body.engagement.averageViews).toBeGreaterThan(0);
    expect(body.formulas.viewRate.en).toMatch(/views ÷ current members/);
    expect(body.sources).toMatchObject({ followers: "api", views: "public_preview" });
    const top = await json(await call(postsRoute.GET, "GET", "/x?sort=top", p()));
    expect(top.posts[0].metrics.views).toBeGreaterThanOrEqual(top.posts[1].metrics.views);
    expect(top.posts[0].viewRate).toBeCloseTo(top.posts[0].metrics.views / 10, 1);
  });

  it("tracks competitor channels from their public preview", async () => {
    await signIn(admin);
    expect((await call(competitorsRoute.POST, "POST", "/x", { ...p(), body: { username: "https://t.me/rival_channel" } })).status).toBe(201);
    expect((await call(competitorsRoute.POST, "POST", "/x", { ...p(), body: { username: "@private_one" } })).status).toBe(201);
    const body = await json(await call(refreshRoute.POST, "POST", "/x", { ...p(), body: {} }));
    const rival = body.competitors.find((c: { username: string }) => c.username === "rival_channel");
    expect(rival).toMatchObject({ status: "ok", snapshot: { source: "public_preview", followers: 12400, avgViews: 3000 } });
    const priv = body.competitors.find((c: { username: string }) => c.username === "private_one");
    expect(priv).toMatchObject({ status: "no_public_preview", snapshot: null });
    expect(priv.statusText.fa).toMatch(/[؀-ۿ]/);
  });

  it("files webhook posts only with the right secret", async () => {
    const row = (await accounts.getAccount(projectId))!;
    const update = { update_id: 1, channel_post: { message_id: 777, date: Math.floor(Date.now() / 1000), chat: { id: -1001234567890, type: "channel", username: "roya_news" }, text: "via webhook" } };
    const send = (secret: string | null) =>
      webhookRoute.POST(
        new NextRequest(new URL(`/api/social/telegram/webhook/${row.id}`, "http://app.example"), {
          method: "POST",
          headers: { "content-type": "application/json", ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}) },
          body: JSON.stringify(update),
        }),
        { params: Promise.resolve({ accountId: row.id }) },
      );
    expect((await send(null)).status).toBe(401);
    expect((await send("0".repeat(64))).status).toBe(401);
    expect(await db.select().from(socialPosts).where(and(eq(socialPosts.projectId, projectId), eq(socialPosts.externalId, "777")))).toHaveLength(0);
    const ok = await send(accounts.webhookSecret(row.id));
    expect(await ok.json()).toMatchObject({ ok: true, ingested: 1 });
  });

  it("registers a webhook with a secret when the panel has a public https address", async () => {
    const before = process.env.APP_URL;
    process.env.APP_URL = "https://panel.example";
    resetEnvCache();
    try {
      await signIn(admin);
      const body = await json(await call(telegramRoute.POST, "POST", "/x", { ...p(), body: { botToken: tg.knobs.token, channel: "@roya_news" } }));
      expect(body.account.profile.updates.mode).toBe("webhook");
      const hook = [...tg.knobs.sent].reverse().find((s) => s.method === "setWebhook")!;
      const row = (await accounts.getAccount(projectId))!;
      expect(hook.body).toMatchObject({
        url: `https://panel.example/api/social/telegram/webhook/${row.id}`,
        secret_token: accounts.webhookSecret(row.id),
        allowed_updates: ["channel_post", "edited_channel_post"],
      });
    } finally {
      process.env.APP_URL = before;
      resetEnvCache();
    }
  });
});

describe("the planner", () => {
  let postId: string;

  it("refuses what Telegram would refuse, when the post is saved", async () => {
    await signIn(editor);
    const res = await call(plannerRoute.POST, "POST", "/x", { ...p(), body: { payload: { op: "post", format: "text", text: "<div>hi</div>" } } });
    expect(res.status).toBe(400);
    expect((await json(res)).error.details.problems).toContain("tag_not_allowed:div");
  });

  it("an editor submits, cannot approve; an admin approves; it is published exactly once", async () => {
    await signIn(editor);
    const created = await json(
      await call(plannerRoute.POST, "POST", "/x", {
        ...p(),
        body: { payload: { op: "post", format: "text", text: "<b>New beans</b> are in #coffee", pin: true }, submit: true },
      }),
    );
    postId = created.post.id;
    expect(created.post.status).toBe("awaiting_approval");
    expect((await call(decisionRoute.POST, "POST", "/x", { ...p({ postId }), body: { decision: "approve" } })).status).toBe(403);

    // Nothing is published while it waits.
    expect(await planner.publishDue(new Date())).toEqual([]);
    // The database refuses to schedule it without a recorded decision.
    await expect(db.update(scheduledPosts).set({ status: "scheduled" }).where(eq(scheduledPosts.id, postId))).rejects.toThrow();

    await signIn(admin);
    const approved = await json(await call(decisionRoute.POST, "POST", "/x", { ...p({ postId }), body: { decision: "approve" } }));
    expect(approved.post).toMatchObject({ status: "scheduled", decidedBy: userIds[0] });

    const sendsBefore = tg.knobs.sent.filter((s) => s.method === "sendMessage").length;
    // Two workers racing for the same post: one claim wins.
    const [a, b] = await Promise.all([planner.publishPost(postId), planner.publishPost(postId)]);
    expect([a.status, b.status].sort()).toEqual(["published", "skipped"]);
    expect(tg.knobs.sent.filter((s) => s.method === "sendMessage").length).toBe(sendsBefore + 1);
    const row = (await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, postId)))[0]!;
    expect(row).toMatchObject({ status: "published", resultPermalink: `https://t.me/roya_news/${row.resultExternalId}` });
    expect(tg.knobs.sent.at(-1)).toMatchObject({ method: "pinChatMessage", body: { message_id: Number(row.resultExternalId) } });
    // The published post is part of the synced posts at once.
    expect(await db.select().from(socialPosts).where(and(eq(socialPosts.projectId, projectId), eq(socialPosts.externalId, row.resultExternalId!)))).toHaveLength(1);

    const cal = await json(await call(calendarRoute.GET, "GET", `/x?from=${new Date(Date.now() - DAY).toISOString()}`, p()));
    expect(cal.timeZone).toBe("Asia/Tehran");
    expect(cal.days.flatMap((d: { posts: Array<{ id: string }> }) => d.posts.map((x) => x.id))).toContain(postId);
  });

  async function approvedPost(text: string): Promise<string> {
    await signIn(admin);
    const created = await json(await call(plannerRoute.POST, "POST", "/x", { ...p(), body: { payload: { op: "post", format: "text", text }, submit: true } }));
    await call(decisionRoute.POST, "POST", "/x", { ...p({ postId: created.post.id }), body: { decision: "approve" } });
    return created.post.id;
  }

  it("a rate limit is retried later; a dropped connection is never re-sent", async () => {
    const limited = await approvedPost("rate limited once");
    tg.knobs.fail.set("sendMessage", { status: 429, description: "Too Many Requests: retry after 90", retryAfter: 90 });
    const first = await planner.publishPost(limited);
    expect(first).toMatchObject({ status: "scheduled", error: "rate_limited" });
    const row = (await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, limited)))[0]!;
    expect(row.publishAt!.getTime()).toBeGreaterThan(Date.now() + 80_000);
    expect(await planner.publishPost(limited, new Date(row.publishAt!.getTime() + 1000))).toMatchObject({ status: "published" });

    const dropped = await approvedPost("the answer never comes");
    tg.knobs.fail.set("sendMessage", "drop");
    const out = await planner.publishPost(dropped);
    expect(out).toMatchObject({ status: "failed", error: "outcome_unknown" });
    const note = await db.select().from(notifications).where(and(eq(notifications.projectId, projectId), eq(notifications.kind, "publish_failed")));
    expect(note).toHaveLength(1);
    expect(note[0]!.severity).toBe("SERIOUS");
    // A person cannot blindly re-send it either.
    await signIn(admin);
    const retry = await call(publishNowRoute.POST, "POST", "/x", { ...p({ postId: dropped }) });
    expect(retry.status).toBe(409);
    expect(await planner.publishDue(new Date())).toEqual([]);
  });

  it("an interrupted publish is reported as unknown, not sent again", async () => {
    const id = await approvedPost("worker died");
    await db.update(scheduledPosts).set({ status: "publishing", claimedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(scheduledPosts.id, id));
    await planner.publishDue(new Date());
    expect((await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id)))[0]).toMatchObject({ status: "failed", error: "outcome_unknown" });
  });

  it("disconnecting forgets the token and keeps the history", async () => {
    await signIn(admin);
    const body = await json(await call(connectionRoute.DELETE, "DELETE", "/x", p()));
    expect(body.account).toMatchObject({ status: "NOT_CONNECTED", connected: false });
    const row = (await db.select().from(socialAccounts).where(eq(socialAccounts.projectId, projectId)))[0]!;
    expect(row.secretCipher).toBeNull();
    expect((await db.select().from(socialPosts).where(eq(socialPosts.projectId, projectId))).length).toBeGreaterThan(20);
    expect((await db.select().from(projects).where(eq(projects.id, projectId)))[0]!.kind).toBe("TELEGRAM");
  });
});
