/**
 * The worker's browser: one Chromium process, started on first use and shut
 * down again when nobody has used it for a while, with one incognito context
 * per remote session and a fresh one for every render.
 *
 * Memory is the constraint (each context costs tens to hundreds of MB), so
 * sessions are capped globally and per organization, a person has at most one
 * (opening another replaces it), and idle or over-age sessions are closed.
 */
import { randomBytes } from "node:crypto";
import { chromium, type Browser } from "playwright-core";
import { BlockedAddressError, childLogger, metric, NotFound } from "@seo/core";
import { BrowserBusy, BrowserUnavailable } from "./errors.js";
import { newHardenedContext, userAgentFor, type UiLocale } from "./context.js";
import { HostGuard } from "./guard.js";
import { startGuardedProxy, type GuardedProxy } from "./proxy.js";
import { renderPage } from "./render.js";
import { BrowserSession, normaliseTarget } from "./session.js";
import type {
  ActionResult,
  BrowserAction,
  Device,
  Frame,
  Owner,
  PageChange,
  RenderResult,
  SessionInfo,
} from "./types.js";

const log = childLogger({ component: "browser" });

export type ManagerOptions = {
  /** 0 turns the browser off: every request answers BROWSER_UNAVAILABLE. */
  maxSessions: number;
  maxSessionsPerOrg: number;
  maxRenders: number;
  idleMs: number;
  maxSessionMs: number;
  /** Chromium itself exits after this long with no session and no render. */
  browserIdleMs: number;
  sweepEveryMs: number;
  executablePath?: string | undefined;
};

export const DEFAULT_OPTIONS: ManagerOptions = {
  maxSessions: 3,
  maxSessionsPerOrg: 2,
  maxRenders: 2,
  idleMs: 5 * 60_000,
  maxSessionMs: 30 * 60_000,
  browserIdleMs: 2 * 60_000,
  sweepEveryMs: 15_000,
};

const LAUNCH_ARGS = [
  // Container /dev/shm is often 64 MB; Chromium crashes renderers when it fills.
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--mute-audio",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-sync",
  "--no-default-browser-check",
  // WebRTC's UDP does not go through the proxy; without this a page could reach
  // internal hosts through STUN/TURN candidates.
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
];

export class BrowserManager {
  private readonly opts: ManagerOptions;
  private readonly guard = new HostGuard();
  private readonly sessions = new Map<string, BrowserSession>();
  /** Sessions being opened (org id by session id), counted against the limits already. */
  private readonly opening = new Map<string, string>();
  private browser: Browser | undefined;
  private launching: Promise<Browser> | undefined;
  private proxy: GuardedProxy | undefined;
  private chromeMajor = "141";
  private renders = 0;
  private lastUsedAt = Date.now();
  private sweeper: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: Partial<ManagerOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  // ---- lifecycle -------------------------------------------------------------

  private async ensureBrowser(): Promise<Browser> {
    if (this.closed) throw new BrowserUnavailable("The browser is shutting down");
    if (this.opts.maxSessions <= 0) throw new BrowserUnavailable("The browser is turned off on this server");
    this.lastUsedAt = Date.now();
    if (this.browser?.isConnected()) return this.browser;
    this.launching ??= this.launch().finally(() => {
      this.launching = undefined;
    });
    return this.launching;
  }

  private async launch(): Promise<Browser> {
    const started = Date.now();
    this.proxy ??= await startGuardedProxy();
    let browser: Browser;
    try {
      browser = await chromium.launch({
        headless: true,
        timeout: 30_000,
        ...(this.opts.executablePath ? { executablePath: this.opts.executablePath } : {}),
        // Loopback goes through the proxy too (Chromium bypasses proxies for it by default).
        proxy: { server: `http://127.0.0.1:${this.proxy.port}`, bypass: "<-loopback>" },
        args: LAUNCH_ARGS,
      });
    } catch (err) {
      log.error({ err: (err as Error).message }, "chromium failed to launch");
      throw new BrowserUnavailable("The browser could not be started");
    }
    this.chromeMajor = browser.version().split(".")[0] ?? this.chromeMajor;
    browser.on("disconnected", () => {
      if (this.browser !== browser) return;
      this.browser = undefined;
      if (this.sessions.size > 0) log.warn({ sessions: this.sessions.size }, "chromium exited; sessions lost");
      for (const s of this.sessions.values()) s.closed = true;
      this.sessions.clear();
    });
    this.browser = browser;
    this.sweeper ??= setInterval(() => void this.sweep(), this.opts.sweepEveryMs).unref();
    log.info({ version: browser.version(), ms: Date.now() - started }, "chromium started");
    metric("browser.launched");
    return browser;
  }

  /** Closes idle and over-age sessions, then Chromium itself once nothing uses it. */
  async sweep(): Promise<void> {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      const idle = now - s.lastUsedAt > this.opts.idleMs;
      const expired = now - s.createdAt > this.opts.maxSessionMs;
      if (idle || expired) await this.dispose(s, idle ? "idle" : "max_age");
    }
    if (
      this.browser &&
      this.sessions.size === 0 &&
      this.opening.size === 0 &&
      this.renders === 0 &&
      !this.launching &&
      now - this.lastUsedAt > this.opts.browserIdleMs
    ) {
      const browser = this.browser;
      this.browser = undefined;
      await browser.close().catch(() => undefined);
      log.info("chromium closed after being idle");
    }
  }

  private async dispose(s: BrowserSession, reason: string): Promise<void> {
    this.sessions.delete(s.id);
    await s.close();
    log.info({ sessionId: s.id, reason, ageMs: Date.now() - s.createdAt }, "browser session closed");
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    await Promise.allSettled([...this.sessions.values()].map((s) => s.close()));
    this.sessions.clear();
    const browser = this.browser ?? (await this.launching?.catch(() => undefined));
    this.browser = undefined;
    await browser?.close().catch(() => undefined);
    await this.proxy?.close();
    this.proxy = undefined;
  }

  stats() {
    return {
      running: Boolean(this.browser?.isConnected()),
      sessions: this.sessions.size,
      renders: this.renders,
      limits: {
        maxSessions: this.opts.maxSessions,
        maxSessionsPerOrg: this.opts.maxSessionsPerOrg,
        maxRenders: this.opts.maxRenders,
      },
    };
  }

  // ---- sessions --------------------------------------------------------------

  private get(owner: Owner, id: string): BrowserSession {
    const s = this.sessions.get(id);
    // Someone else's session answers exactly like a missing one.
    if (!s || s.closed || s.owner.orgId !== owner.orgId || s.owner.userId !== owner.userId) {
      throw new NotFound("Browser session not found");
    }
    return s;
  }

  private async checkTarget(input: string): Promise<string> {
    const target = normaliseTarget(input);
    const verdict = await this.guard.check(target);
    if (!verdict.ok) throw new BlockedAddressError(new URL(target).hostname, verdict.reason);
    return target;
  }

  async createSession(
    owner: Owner,
    input: { url: string; device: Device; locale?: UiLocale },
  ): Promise<SessionInfo> {
    if (this.opts.maxSessions <= 0) throw new BrowserUnavailable("The browser is turned off on this server");
    const target = await this.checkTarget(input.url);

    // One per person: a new one (another tab, a reload) replaces the old.
    for (const s of [...this.sessions.values()]) {
      if (s.owner.orgId === owner.orgId && s.owner.userId === owner.userId) await this.dispose(s, "replaced");
    }
    if (this.sessions.size + this.opening.size >= this.opts.maxSessions) throw new BrowserBusy("capacity");
    const inOrg =
      [...this.sessions.values()].filter((s) => s.owner.orgId === owner.orgId).length +
      [...this.opening.values()].filter((org) => org === owner.orgId).length;
    if (inOrg >= this.opts.maxSessionsPerOrg) throw new BrowserBusy("org_limit");

    const id = randomBytes(16).toString("hex");
    // Reserved before the first await, so concurrent requests cannot both take the last slot.
    this.opening.set(id, owner.orgId);
    let session: BrowserSession | undefined;
    try {
      const browser = await this.ensureBrowser();
      const { context } = await newHardenedContext(browser, {
        device: input.device,
        chromeMajor: this.chromeMajor,
        guard: this.guard,
        locale: input.locale ?? "fa",
      });
      session = new BrowserSession(id, owner, input.device, context, this.guard);
      this.sessions.set(id, session);
      await session.init();
      await session.navigate(target);
    } catch (err) {
      if (session) await this.dispose(session, "failed_to_start");
      throw err;
    } finally {
      this.opening.delete(id);
    }
    metric("browser.session.created");
    log.info({ sessionId: id, orgId: owner.orgId, device: input.device }, "browser session opened");
    return { id, width: session.width, height: session.height, device: input.device, ...session.state() };
  }

  async frame(owner: Owner, id: string, ifNoneMatch?: string | null): Promise<Frame> {
    const s = this.get(owner, id);
    s.touch();
    this.lastUsedAt = Date.now();
    const { frame, state } = await s.currentFrame();
    const etag = `"${id.slice(0, 8)}.${frame.version}"`;
    if (ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) {
      return { notModified: true, etag, state };
    }
    return { notModified: false, etag, state, body: frame.body };
  }

  async action(owner: Owner, id: string, action: BrowserAction): Promise<ActionResult> {
    this.lastUsedAt = Date.now();
    return this.get(owner, id).act(action);
  }

  async closeSession(owner: Owner, id: string): Promise<void> {
    await this.dispose(this.get(owner, id), "closed_by_user");
  }

  // ---- render ----------------------------------------------------------------

  async render(input: {
    url: string;
    device: Device;
    changes?: PageChange[] | undefined;
    locale?: UiLocale | undefined;
  }): Promise<RenderResult> {
    const target = await this.checkTarget(input.url);
    if (this.renders >= this.opts.maxRenders) throw new BrowserBusy("renders");
    this.renders++;
    try {
      const browser = await this.ensureBrowser();
      const { context, blockedCount } = await newHardenedContext(browser, {
        device: input.device,
        chromeMajor: this.chromeMajor,
        guard: this.guard,
        locale: input.locale ?? "fa",
      });
      const started = Date.now();
      try {
        return await renderPage(context, {
          url: target,
          device: input.device,
          ...(input.changes ? { changes: input.changes } : {}),
          userAgent: userAgentFor(input.device, this.chromeMajor),
          blockedCount,
        });
      } finally {
        await context.close().catch(() => undefined);
        metric("browser.render.ms", Date.now() - started);
      }
    } finally {
      this.renders--;
      this.lastUsedAt = Date.now();
    }
  }
}
