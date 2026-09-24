/**
 * Planned posts: draft → awaiting_approval → scheduled → publishing →
 * published | failed, with rejected and canceled on the side.
 *
 * Publishing speaks in the owner's name, so it is SENSITIVE: a person with
 * approval rights decides every post, and the database refuses a scheduled,
 * publishing, published or failed row without the decision recorded.
 *
 * Never posting twice is the publisher's first duty:
 *  - a post is published only by the worker that moved it from scheduled to
 *    publishing in one conditional UPDATE (the claim);
 *  - a failure that proves nothing reached the platform (refused request,
 *    unreachable host, rate limit) is retried a bounded number of times;
 *  - a failure after the irreversible call may have published (a timeout
 *    mid-request, a worker that died): that post becomes failed with
 *    outcome_unknown and is never sent again automatically. A person checks
 *    the channel and decides.
 */
import { z } from "zod";
import {
  and,
  asc,
  db,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  projects,
  scheduledPosts,
  sql,
  type Project,
  type ScheduledPost,
  type ScheduledPostPayload,
  type SocialPlatform,
} from "@seo/db";
import { BadRequest, Conflict, NotFound, SYSTEM, childLogger, recordAudit, requiresApproval } from "@seo/core";
import {
  INSTAGRAM_PUBLISH_LIMIT,
  InstagramError,
  TELEGRAM_CAPTION_MAX,
  TELEGRAM_TEXT_MAX,
  TelegramError,
  instagramClient,
  telegramBot,
  telegramMessageLink,
  type TgMessage,
} from "@seo/connectors";
import { assertSocialProject, connectedAccount, getAccount, type SocialSecret } from "./accounts.js";
import { publishFailed } from "./alerts.js";
import { DEFAULT_TIMEZONE } from "./analytics.js";
import { ingestTelegramMessages } from "./sync.js";
import { extractHashtags, telegramHtmlProblems, telegramVisibleText } from "./text.js";

export const MAX_PUBLISH_ATTEMPTS = 3;
/** A post still `publishing` this long after its claim was interrupted: its outcome is unknown. */
export const STALE_PUBLISHING_MS = 15 * 60_000;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];

/** Container polling for Instagram videos; tests shorten it. */
export const timing = { pollMs: 5_000, maxPolls: 60 };

const httpsUrl = z
  .string()
  .trim()
  .url()
  .max(2000)
  .refine((u) => /^https:\/\//i.test(u), "must be an https URL the platform can download");

const media = z.object({
  url: httpsUrl,
  type: z.enum(["image", "video"]),
  altText: z.string().trim().max(1000).nullable().optional(),
});

export const payloadInput = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("post"),
    format: z.enum(["image", "carousel", "reel", "text", "photo", "album", "video"]),
    text: z.string().max(10_000).default(""),
    media: z.array(media).max(10).default([]),
    pin: z.boolean().optional(),
    silent: z.boolean().optional(),
    shareToFeed: z.boolean().optional(),
  }),
  z.object({ op: z.literal("edit"), messageId: z.number().int().positive(), text: z.string().min(1).max(10_000), target: z.enum(["text", "caption"]) }),
  z.object({ op: z.literal("pin"), messageId: z.number().int().positive(), silent: z.boolean().optional() }),
]);

export const postInput = z.object({
  payload: payloadInput,
  /** ISO time; absent = publish as soon as approved. */
  publishAt: z.string().datetime({ offset: true }).nullable().optional(),
  /** Submit for approval right away instead of keeping a draft. */
  submit: z.boolean().default(false),
});

export const postUpdateInput = postInput.partial().extend({ submit: z.boolean().optional() });

/** Everything a platform would refuse, found when the post is saved rather than when it is due. */
export function validatePayload(platform: SocialPlatform, p: ScheduledPostPayload): string[] {
  const problems: string[] = [];
  if (platform === "INSTAGRAM") {
    if (p.op !== "post") return ["instagram_supports_new_posts_only"];
    if (!["image", "carousel", "reel"].includes(p.format)) problems.push("format_not_for_instagram");
    if ([...p.text].length > 2200) problems.push("caption_too_long:2200");
    if (extractHashtags(p.text).length > 30) problems.push("too_many_hashtags:30");
    if (p.format === "image" && (p.media.length !== 1 || p.media[0]!.type !== "image")) problems.push("image_needs_one_image");
    if (p.format === "reel" && (p.media.length !== 1 || p.media[0]!.type !== "video")) problems.push("reel_needs_one_video");
    if (p.format === "carousel" && (p.media.length < 2 || p.media.length > 10)) problems.push("carousel_needs_2_to_10_items");
    if (p.media.some((m) => m.type === "image" && !/\.jpe?g(\?|$)/i.test(m.url))) problems.push("instagram_images_must_be_jpeg");
    return problems;
  }
  if (p.op === "pin") return [];
  const html = p.op === "edit" ? p.text : p.text;
  problems.push(...telegramHtmlProblems(html));
  const visible = [...telegramVisibleText(html)].length;
  if (p.op === "edit") {
    if (visible > (p.target === "text" ? TELEGRAM_TEXT_MAX : TELEGRAM_CAPTION_MAX)) problems.push("text_too_long");
    return problems;
  }
  if (!["text", "photo", "album", "video"].includes(p.format)) problems.push("format_not_for_telegram");
  if (p.format === "text") {
    if (!visible) problems.push("text_required");
    if (visible > TELEGRAM_TEXT_MAX) problems.push(`text_too_long:${TELEGRAM_TEXT_MAX}`);
    if (p.media.length) problems.push("text_post_has_no_media");
  } else {
    if (visible > TELEGRAM_CAPTION_MAX) problems.push(`caption_too_long:${TELEGRAM_CAPTION_MAX}`);
    if (p.format === "photo" && (p.media.length !== 1 || p.media[0]!.type !== "image")) problems.push("photo_needs_one_image");
    if (p.format === "video" && (p.media.length !== 1 || p.media[0]!.type !== "video")) problems.push("video_needs_one_video");
    if (p.format === "album" && (p.media.length < 2 || p.media.length > 10)) problems.push("album_needs_2_to_10_items");
  }
  return problems;
}

function assertValid(platform: SocialPlatform, payload: ScheduledPostPayload): void {
  const problems = validatePayload(platform, payload);
  if (problems.length) throw new BadRequest("The post cannot be published as it is", { reason: "invalid_post", problems });
}

async function getPost(projectId: string, id: string): Promise<ScheduledPost> {
  const row = (await db.select().from(scheduledPosts).where(and(eq(scheduledPosts.projectId, projectId), eq(scheduledPosts.id, id))).limit(1))[0];
  if (!row) throw new NotFound("Planned post not found");
  return row;
}

export async function createPost(project: Project, input: z.input<typeof postInput>, userId: string | null): Promise<ScheduledPost> {
  const parsed = postInput.parse(input);
  const platform = assertSocialProject(project);
  const payload = parsed.payload as ScheduledPostPayload;
  assertValid(platform, payload);
  const now = new Date();
  return (
    await db
      .insert(scheduledPosts)
      .values({
        projectId: project.id,
        platform,
        status: parsed.submit ? "awaiting_approval" : "draft",
        publishAt: parsed.publishAt ? new Date(parsed.publishAt) : null,
        payload,
        requestedBy: parsed.submit ? userId : null,
        requestedAt: parsed.submit ? now : null,
      })
      .returning()
  )[0]!;
}

const EDITABLE = ["draft", "awaiting_approval", "rejected"] as const;

/** An edit invalidates any request for approval: what gets approved is what gets published. */
export async function updatePost(
  project: Project,
  id: string,
  raw: z.input<typeof postUpdateInput>,
  userId: string | null,
): Promise<ScheduledPost> {
  const input = postUpdateInput.parse(raw);
  const current = await getPost(project.id, id);
  if (!(EDITABLE as readonly string[]).includes(current.status)) throw new Conflict(`A ${current.status} post cannot be edited`, { status: current.status });
  const payload = (input.payload ?? current.payload) as ScheduledPostPayload;
  assertValid(current.platform, payload);
  const submit = input.submit ?? false;
  const now = new Date();
  const updated = await db
    .update(scheduledPosts)
    .set({
      payload,
      ...(input.publishAt !== undefined ? { publishAt: input.publishAt ? new Date(input.publishAt) : null } : {}),
      status: submit ? "awaiting_approval" : "draft",
      requestedBy: submit ? userId : null,
      requestedAt: submit ? now : null,
      decisionReason: null,
      updatedAt: now,
    })
    .where(and(eq(scheduledPosts.id, id), inArray(scheduledPosts.status, [...EDITABLE])))
    .returning();
  if (!updated[0]) throw new Conflict("The post changed state meanwhile; reload it");
  return updated[0];
}

export async function submitPost(project: Project, id: string, userId: string | null): Promise<ScheduledPost> {
  const updated = await db
    .update(scheduledPosts)
    .set({ status: "awaiting_approval", requestedBy: userId, requestedAt: new Date(), decisionReason: null, updatedAt: new Date() })
    .where(and(eq(scheduledPosts.projectId, project.id), eq(scheduledPosts.id, id), inArray(scheduledPosts.status, ["draft", "rejected"])))
    .returning();
  if (!updated[0]) {
    const current = await getPost(project.id, id);
    throw new Conflict(`A ${current.status} post cannot be submitted`, { status: current.status });
  }
  return updated[0];
}

/**
 * A person approves (never an agent or API key: the route requires a session
 * with fix:approve_sensitive). The approved post is scheduled for its time, or
 * for now when it has none.
 */
export async function decidePost(
  project: Project,
  id: string,
  input: { approve: boolean; reason?: string | null; actor: { type: string; id: string | null } },
): Promise<ScheduledPost> {
  if (input.actor.type !== "USER" || !input.actor.id) throw new Conflict("Only a person can approve or reject a post");
  // The policy table is the single place that says publishing needs approval.
  if (!requiresApproval("SOCIAL_POST")) throw new Error("SOCIAL_POST must require approval");
  const now = new Date();
  const updated = await db
    .update(scheduledPosts)
    .set(
      input.approve
        ? { status: "scheduled", decidedBy: input.actor.id, decidedAt: now, decisionReason: input.reason ?? null, publishAt: sql`coalesce(${scheduledPosts.publishAt}, ${now})`, error: null, updatedAt: now }
        : { status: "rejected", decidedBy: input.actor.id, decidedAt: now, decisionReason: input.reason ?? null, updatedAt: now },
    )
    .where(and(eq(scheduledPosts.projectId, project.id), eq(scheduledPosts.id, id), eq(scheduledPosts.status, "awaiting_approval")))
    .returning();
  if (!updated[0]) {
    const current = await getPost(project.id, id);
    throw new Conflict(`A ${current.status} post cannot be decided`, { status: current.status });
  }
  return updated[0];
}

export async function cancelPost(project: Project, id: string): Promise<ScheduledPost> {
  const updated = await db
    .update(scheduledPosts)
    .set({ status: "canceled", updatedAt: new Date() })
    .where(
      and(
        eq(scheduledPosts.projectId, project.id),
        eq(scheduledPosts.id, id),
        inArray(scheduledPosts.status, ["draft", "awaiting_approval", "rejected", "scheduled", "failed"]),
      ),
    )
    .returning();
  if (!updated[0]) {
    const current = await getPost(project.id, id);
    throw new Conflict(`A ${current.status} post cannot be canceled`, { status: current.status });
  }
  return updated[0];
}

/**
 * Publish an approved post now. A failed post can be retried this way by a
 * person — except one whose outcome is unknown, which might already be live.
 */
export async function publishNow(project: Project, id: string): Promise<ScheduledPost> {
  const now = new Date();
  const updated = await db
    .update(scheduledPosts)
    .set({ status: "scheduled", publishAt: now, updatedAt: now })
    .where(
      and(
        eq(scheduledPosts.projectId, project.id),
        eq(scheduledPosts.id, id),
        or(
          eq(scheduledPosts.status, "scheduled"),
          and(eq(scheduledPosts.status, "failed"), sql`coalesce(${scheduledPosts.error}, '') <> 'outcome_unknown'`),
        ),
      ),
    )
    .returning();
  if (!updated[0]) {
    const current = await getPost(project.id, id);
    const reason = current.status === "failed" ? "outcome_unknown" : current.status;
    throw new Conflict(
      current.status === "failed"
        ? "This post may already be live (its last attempt ended mid-publish); check the channel before posting it again as a new post"
        : `A ${current.status} post cannot be published now`,
      { status: current.status, reason },
    );
  }
  return updated[0];
}

export async function listPosts(projectId: string, filter: { from?: Date; to?: Date; status?: string[] } = {}): Promise<ScheduledPost[]> {
  const clauses = [eq(scheduledPosts.projectId, projectId)];
  if (filter.status?.length) clauses.push(inArray(scheduledPosts.status, filter.status as ScheduledPost["status"][]));
  if (filter.from) clauses.push(or(isNull(scheduledPosts.publishAt), gte(scheduledPosts.publishAt, filter.from))!);
  if (filter.to) clauses.push(or(isNull(scheduledPosts.publishAt), lte(scheduledPosts.publishAt, filter.to))!);
  return db.select().from(scheduledPosts).where(and(...clauses)).orderBy(asc(scheduledPosts.publishAt), asc(scheduledPosts.createdAt)).limit(500);
}

/** Posts with a time in [from, to], grouped by day in the profile's timezone. */
export async function calendar(projectId: string, from: Date, to: Date) {
  const account = await getAccount(projectId);
  const timeZone = account?.settings.timezone ?? DEFAULT_TIMEZONE;
  const rows = await db
    .select()
    .from(scheduledPosts)
    .where(and(eq(scheduledPosts.projectId, projectId), gte(scheduledPosts.publishAt, from), lte(scheduledPosts.publishAt, to)))
    .orderBy(asc(scheduledPosts.publishAt));
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const days = new Map<string, ScheduledPost[]>();
  for (const r of rows) {
    const day = fmt.format(r.publishedAt ?? r.publishAt!);
    (days.get(day) ?? days.set(day, []).get(day)!).push(r);
  }
  return { timeZone, days: [...days.entries()].map(([date, posts]) => ({ date, posts: posts.map(postView) })) };
}

export function postView(p: ScheduledPost) {
  return {
    id: p.id,
    platform: p.platform,
    status: p.status,
    publishAt: p.publishAt?.toISOString() ?? null,
    payload: p.payload,
    requestedBy: p.requestedBy,
    requestedAt: p.requestedAt?.toISOString() ?? null,
    decidedBy: p.decidedBy,
    decidedAt: p.decidedAt?.toISOString() ?? null,
    decisionReason: p.decisionReason,
    attempts: p.attempts,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    resultExternalId: p.resultExternalId,
    resultPermalink: p.resultPermalink,
    error: p.error,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------- publishing

/** Thrown when a failure happened after the platform may have acted on the request. */
class OutcomeUnknown extends Error {
  readonly code = "outcome_unknown";
}

/** Run the irreversible call: an answer-less failure (timeout, dropped connection) may have published. */
async function irreversible<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if ((err instanceof TelegramError || err instanceof InstagramError) && err.delivery === "unknown") throw new OutcomeUnknown(err.message);
    throw err;
  }
}

type Published = { externalId: string; permalink: string | null; warnings: string[] };

async function publishTelegram(post: ScheduledPost, account: { externalId: string; username: string | null; secret: SocialSecret; projectId: string }): Promise<Published> {
  const bot = telegramBot(account.secret.botToken ?? "");
  const chat = account.externalId;
  const p = post.payload;
  const link = (id: number) => telegramMessageLink({ id: chat, username: account.username }, id);
  if (p.op === "pin") {
    await irreversible(() => bot.pinChatMessage(chat, p.messageId, p.silent ?? true));
    return { externalId: String(p.messageId), permalink: link(p.messageId), warnings: [] };
  }
  if (p.op === "edit") {
    try {
      await irreversible(() => (p.target === "text" ? bot.editMessageText(chat, p.messageId, p.text) : bot.editMessageCaption(chat, p.messageId, p.text)));
    } catch (err) {
      // Already reads this way: the goal is met.
      if (!(err instanceof TelegramError && /not modified/i.test(err.message))) throw err;
    }
    return { externalId: String(p.messageId), permalink: link(p.messageId), warnings: [] };
  }
  let sent: TgMessage;
  const opts = { silent: p.silent };
  if (p.format === "text") sent = await irreversible(() => bot.sendMessage(chat, p.text, opts));
  else if (p.format === "photo") sent = await irreversible(() => bot.sendPhoto(chat, p.media[0]!.url, p.text, opts));
  else if (p.format === "video") sent = await irreversible(() => bot.sendVideo(chat, p.media[0]!.url, p.text, opts));
  else {
    const all = await irreversible(() =>
      bot.sendMediaGroup(chat, p.media.map((m) => ({ type: m.type === "video" ? "video" : "photo", url: m.url })), p.text, opts),
    );
    sent = all[0]!;
  }
  const warnings: string[] = [];
  const row = (await getAccount(account.projectId))!;
  await ingestTelegramMessages(row, [{ ...sent, caption: sent.caption ?? (p.format !== "text" ? p.text : undefined) }]);
  if (p.pin) {
    // The post is live whatever happens here; a failed pin is reported, not retried as a post.
    try {
      await bot.pinChatMessage(chat, sent.message_id, true);
    } catch (err) {
      warnings.push(`pin_failed:${(err as TelegramError).code ?? "error"}`);
    }
  }
  return { externalId: String(sent.message_id), permalink: link(sent.message_id), warnings };
}

async function waitForContainer(client: ReturnType<typeof instagramClient>, containerId: string): Promise<void> {
  for (let i = 0; i < timing.maxPolls; i++) {
    const { status } = await client.containerStatus(containerId);
    if (status === "FINISHED" || status === "PUBLISHED") return;
    if (status === "ERROR") throw new InstagramError("container_error", "Instagram could not process the media", "rejected");
    if (status === "EXPIRED") throw new InstagramError("container_expired", "The media container expired", "not_sent");
    await new Promise((r) => setTimeout(r, timing.pollMs));
  }
  throw new InstagramError("container_timeout", "Instagram took too long to process the media", "not_sent");
}

async function publishInstagram(post: ScheduledPost, account: { externalId: string; secret: SocialSecret }): Promise<Published> {
  const p = post.payload;
  if (p.op !== "post") throw new InstagramError("bad_request", "Instagram supports new posts only", "rejected");
  const client = instagramClient(account.secret.accessToken ?? "", account.externalId);
  const quota = await client.publishingLimit();
  if (quota.used >= (quota.total || INSTAGRAM_PUBLISH_LIMIT)) {
    throw new InstagramError("publish_limit_reached", "Instagram's 24-hour publishing limit is reached", "not_sent");
  }
  // A container from an attempt that failed before publishing can be reused (they live 24 hours).
  let containerId = (post.progress.containerId as string | undefined) ?? null;
  if (!containerId) {
    if (p.format === "carousel") {
      const children: string[] = [];
      for (const m of p.media) {
        children.push(
          await client.createContainer(
            m.type === "image"
              ? { kind: "image", imageUrl: m.url, altText: m.altText ?? null, carouselItem: true }
              : { kind: "video", videoUrl: m.url, carouselItem: true },
          ),
        );
      }
      for (const c of children) await waitForContainer(client, c);
      containerId = await client.createContainer({ kind: "carousel", children, caption: p.text });
    } else if (p.format === "reel") {
      containerId = await client.createContainer({ kind: "reel", videoUrl: p.media[0]!.url, caption: p.text, shareToFeed: p.shareToFeed });
    } else {
      containerId = await client.createContainer({ kind: "image", imageUrl: p.media[0]!.url, caption: p.text, altText: p.media[0]!.altText ?? null });
    }
    await db
      .update(scheduledPosts)
      .set({ progress: sql`${scheduledPosts.progress} || ${JSON.stringify({ containerId })}::jsonb` })
      .where(eq(scheduledPosts.id, post.id));
  }
  try {
    await waitForContainer(client, containerId);
  } catch (err) {
    // An expired or failed container cannot be published; the next attempt makes a new one.
    if (err instanceof InstagramError && (err.code === "container_expired" || err.code === "container_error")) {
      await db.update(scheduledPosts).set({ progress: sql`${scheduledPosts.progress} - 'containerId'` }).where(eq(scheduledPosts.id, post.id));
    }
    throw err;
  }
  const mediaId = await irreversible(() => client.publish(containerId!));
  let permalink: string | null = null;
  const warnings: string[] = [];
  try {
    permalink = await client.permalink(mediaId);
  } catch {
    warnings.push("permalink_unavailable");
  }
  return { externalId: mediaId, permalink, warnings };
}

export type PublishOutcome = { postId: string; status: ScheduledPost["status"] | "skipped"; error?: string | null };

/** Claim and publish one due post. A post someone else claimed, or not yet due, is skipped. */
export async function publishPost(postId: string, now = new Date()): Promise<PublishOutcome> {
  const log = childLogger({ component: "social-publisher", postId });
  const claimed = (
    await db
      .update(scheduledPosts)
      .set({ status: "publishing", attempts: sql`${scheduledPosts.attempts} + 1`, claimedAt: now, updatedAt: now })
      .where(
        and(
          eq(scheduledPosts.id, postId),
          eq(scheduledPosts.status, "scheduled"),
          or(isNull(scheduledPosts.publishAt), lte(scheduledPosts.publishAt, now)),
        ),
      )
      .returning()
  )[0];
  if (!claimed) return { postId, status: "skipped" };
  const project = (await db.select().from(projects).where(eq(projects.id, claimed.projectId)).limit(1))[0]!;

  let result: Published | null = null;
  let failure: { code: string; retry: boolean; retryAfter?: number | null } | null = null;
  try {
    const account = await connectedAccount(claimed.projectId);
    if (account.platform !== claimed.platform) throw Object.assign(new Error("wrong_platform"), { code: "wrong_platform" });
    result =
      claimed.platform === "TELEGRAM"
        ? await publishTelegram(claimed, { externalId: account.externalId!, username: account.username, secret: account.secret, projectId: account.projectId })
        : await publishInstagram(claimed, { externalId: account.externalId!, secret: account.secret });
  } catch (err) {
    if (err instanceof OutcomeUnknown) failure = { code: "outcome_unknown", retry: false };
    else if (err instanceof TelegramError || err instanceof InstagramError) {
      failure = { code: err.code, retry: err.transient, retryAfter: err instanceof TelegramError ? err.retryAfter : null };
    } else if ((err as { code?: string }).code === "not_connected" || (err as { details?: { reason?: string } }).details?.reason === "not_connected") {
      failure = { code: "not_connected", retry: false };
    } else {
      // An unexpected error before any platform call: nothing was sent, but a bug should not loop.
      log.error({ err: (err as Error).message }, "publish failed unexpectedly");
      failure = { code: "api_error", retry: false };
    }
  }

  if (result) {
    const done = (
      await db
        .update(scheduledPosts)
        .set({
          status: "published",
          publishedAt: new Date(),
          resultExternalId: result.externalId,
          resultPermalink: result.permalink,
          error: result.warnings.length ? result.warnings.join(",") : null,
          updatedAt: new Date(),
        })
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.status, "publishing")))
        .returning()
    )[0];
    await recordAudit({
      orgId: project.orgId,
      actor: SYSTEM,
      action: "social.post_published",
      targetType: "scheduled_post",
      targetId: postId,
      metadata: { platform: claimed.platform, op: claimed.payload.op, externalId: result.externalId, attempts: claimed.attempts },
    });
    log.info({ externalId: result.externalId }, "post published");
    return { postId, status: done?.status ?? "published" };
  }

  const f = failure!;
  const retry = f.retry && claimed.attempts < MAX_PUBLISH_ATTEMPTS;
  const delay = Math.max(BACKOFF_MS[claimed.attempts - 1] ?? BACKOFF_MS.at(-1)!, (f.retryAfter ?? 0) * 1000);
  const updated = (
    await db
      .update(scheduledPosts)
      .set(
        retry
          ? { status: "scheduled", publishAt: new Date(now.getTime() + delay), error: f.code, updatedAt: new Date() }
          : { status: "failed", error: f.code, updatedAt: new Date() },
      )
      .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.status, "publishing")))
      .returning()
  )[0]!;
  log.warn({ code: f.code, retry, attempts: claimed.attempts }, retry ? "publish attempt failed, will retry" : "publish failed");
  if (!retry) {
    await recordAudit({
      orgId: project.orgId,
      actor: SYSTEM,
      action: "social.post_failed",
      targetType: "scheduled_post",
      targetId: postId,
      metadata: { platform: claimed.platform, reason: f.code, attempts: claimed.attempts },
    });
    await publishFailed(updated, f.code).catch((err: Error) => log.error({ err: err.message }, "publish_failed notification not recorded"));
  }
  return { postId, status: updated.status, error: f.code };
}

/**
 * The publisher's tick: report posts whose publishing was interrupted, then
 * hand what is due to `dispatch` (the worker enqueues a publish job; tests
 * publish inline). Several workers may tick at once and a job may run twice;
 * the claim in publishPost lets exactly one of them publish each post.
 */
export async function publishDue<T = PublishOutcome>(
  now = new Date(),
  opts: { limit?: number; dispatch?: (postId: string, projectId: string) => Promise<T> } = {},
): Promise<T[]> {
  const dispatch = opts.dispatch ?? ((id: string) => publishPost(id, now) as Promise<T>);
  const stale = await db
    .update(scheduledPosts)
    .set({ status: "failed", error: "outcome_unknown", updatedAt: now })
    .where(and(eq(scheduledPosts.status, "publishing"), lt(scheduledPosts.claimedAt, new Date(now.getTime() - STALE_PUBLISHING_MS))))
    .returning();
  for (const s of stale) await publishFailed(s, "outcome_unknown").catch(() => undefined);

  const due = await db
    .select({ id: scheduledPosts.id, projectId: scheduledPosts.projectId })
    .from(scheduledPosts)
    .where(and(eq(scheduledPosts.status, "scheduled"), or(isNull(scheduledPosts.publishAt), lte(scheduledPosts.publishAt, now))))
    .orderBy(asc(scheduledPosts.publishAt))
    .limit(opts.limit ?? 20);
  const out: T[] = [];
  for (const d of due) out.push(await dispatch(d.id, d.projectId));
  return out;
}
