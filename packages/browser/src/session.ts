/**
 * One remote browser tab, owned by one person in one organization.
 *
 * Frames are screenshots taken when someone asks for one, at most every 200 ms
 * while something is happening and every 900 ms while the page sits still. A
 * frame's version only moves when the picture changes, so a poll that sees
 * the same version costs the viewer nothing but a 304.
 */
import { createHash } from "node:crypto";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { BadRequest, BlockedAddressError } from "@seo/core";
import { BrowserUnavailable } from "./errors.js";
import { VIEWPORTS } from "./context.js";
import { selectionScript } from "./page-scripts.js";
import type { HostGuard } from "./guard.js";
import type { ActionResult, BrowserAction, Device, Owner, PageState } from "./types.js";

const HOT_FRAME_MS = 200;
const COLD_FRAME_MS = 900;
const ACTION_TIMEOUT_MS = 15_000;
const NAV_TIMEOUT_MS = 15_000;
/** A page that never fires `load` (one hanging image) stops showing as loading after this. */
const LOADING_CAP_MS = 20_000;
const CLIPBOARD_MAX = 10_000;

/** Adds https:// to a bare host and refuses anything that is not http(s). */
export function normaliseTarget(input: string): string {
  const text = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+(\/|$)/.test(text) ? text : `https://${text}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new BadRequest("That is not a valid web address");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new BadRequest("Only http and https addresses can be opened");
  }
  return u.toString();
}

/** "net::ERR_NAME_NOT_RESOLVED at https://…" → "ERR_NAME_NOT_RESOLVED". */
export function netErrorName(err: unknown): string {
  const message = (err as Error)?.message ?? "";
  const m = /net::(ERR_[A-Z_]+)/.exec(message);
  if (m) return m[1]!;
  if ((err as Error)?.name === "TimeoutError") return "ERR_TIMED_OUT";
  return "ERR_FAILED";
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BrowserUnavailable("The page is not responding")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type StoredFrame = { body: Buffer; hash: string; version: number; takenAt: number };

export class BrowserSession {
  readonly createdAt = Date.now();
  lastUsedAt = Date.now();
  closed = false;
  readonly width: number;
  readonly height: number;
  page!: Page;
  private cdp: CDPSession | undefined;
  private frame: StoredFrame | undefined;
  private version = 0;
  private capturing: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private lastActionAt = 0;
  private lastChangeAt = 0;
  private loadingSince: number | null = null;
  private lastRequestedUrl: string | undefined;
  private title = "";
  private canGoBack = false;
  private canGoForward = false;
  private error: string | undefined;
  private clipboard = "";

  constructor(
    readonly id: string,
    readonly owner: Owner,
    readonly device: Device,
    readonly context: BrowserContext,
    private readonly guard: HostGuard,
  ) {
    this.width = VIEWPORTS[device].width;
    this.height = VIEWPORTS[device].height;
  }

  async init(): Promise<void> {
    this.page = await this.context.newPage();
    const page = this.page;
    page.on("request", (req) => {
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        this.loadingSince = Date.now();
        this.lastRequestedUrl = req.url();
        this.error = undefined;
      }
    });
    page.on("requestfailed", (req) => {
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        this.loadingSince = null;
        const failure = req.failure()?.errorText ?? "";
        // A navigation replaced by another one is not a failure the viewer should see.
        if (!failure.includes("ERR_ABORTED")) this.error = netErrorName({ message: failure });
      }
    });
    page.on("load", () => {
      this.loadingSince = null;
    });
    // A native dialog would block the page until someone answers it, and nobody can.
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));
    // With a listener attached the chooser is intercepted and simply never answered.
    page.on("filechooser", () => undefined);
    // New tabs (target=_blank, window.open) open in this one instead.
    this.context.on("page", (popup) => void this.adoptPopup(popup));
    this.cdp = await this.context.newCDPSession(page).catch(() => undefined);
  }

  private async adoptPopup(popup: Page): Promise<void> {
    if (popup === this.page) return;
    let target = popup.url();
    if (!target || target === "about:blank") {
      const req = await popup
        .waitForEvent("request", { predicate: (r) => r.isNavigationRequest(), timeout: 5_000 })
        .catch(() => null);
      target = req?.url() ?? "";
    }
    await popup.close().catch(() => undefined);
    if (!this.closed && /^https?:/i.test(target)) {
      await this.page.goto(target, { waitUntil: "commit", timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
    }
  }

  touch(): void {
    this.lastUsedAt = Date.now();
  }

  private loading(): boolean {
    return this.loadingSince !== null && Date.now() - this.loadingSince < LOADING_CAP_MS;
  }

  state(): PageState {
    const raw = this.page.url();
    const url =
      raw.startsWith("chrome-error:") || raw === "about:blank" ? (this.lastRequestedUrl ?? raw) : raw;
    return {
      url,
      title: this.title,
      loading: this.loading(),
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private async refreshState(): Promise<void> {
    this.title = await this.page.title().catch(() => this.title);
    if (!this.cdp) return;
    const history = (await this.cdp.send("Page.getNavigationHistory").catch(() => null)) as {
      currentIndex: number;
      entries: Array<{ url: string }>;
    } | null;
    if (history) {
      // The blank page every tab starts on is not somewhere to go back to.
      const first = history.entries.findIndex((e) => e.url !== "about:blank");
      this.canGoBack = first >= 0 && history.currentIndex > first;
      this.canGoForward = history.currentIndex < history.entries.length - 1;
    }
  }

  /** The current frame; takes a new screenshot only if the last one is older than the cadence allows. */
  async currentFrame(): Promise<{ frame: StoredFrame; state: PageState }> {
    const now = Date.now();
    const hot = now - this.lastActionAt < 4_000 || now - this.lastChangeAt < 3_000 || this.loading();
    const interval = hot ? HOT_FRAME_MS : COLD_FRAME_MS;
    if (!this.frame || now - this.frame.takenAt >= interval) {
      // A slow screenshot (a page mid-navigation) keeps showing the last picture.
      await this.capture().catch(() => {
        if (!this.frame) throw new BrowserUnavailable("The page has not painted yet", { reason: "no_frame" });
      });
    }
    return { frame: this.frame!, state: this.state() };
  }

  private capture(): Promise<void> {
    this.capturing ??= (async () => {
      const body = await this.page.screenshot({
        type: "jpeg",
        quality: 60,
        scale: "css",
        timeout: 5_000,
        caret: "initial",
      });
      const hash = createHash("sha1").update(body).digest("hex");
      const now = Date.now();
      if (!this.frame || this.frame.hash !== hash) {
        this.version++;
        this.lastChangeAt = now;
        this.frame = { body, hash, version: this.version, takenAt: now };
      } else {
        this.frame.takenAt = now;
      }
      await this.refreshState();
    })().finally(() => {
      this.capturing = undefined;
    });
    return this.capturing;
  }

  /** Actions run one at a time: a click must not overtake the navigation typed before it. */
  act(action: BrowserAction): Promise<ActionResult> {
    const run = this.queue.then(() => withTimeout(this.perform(action), ACTION_TIMEOUT_MS));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async perform(action: BrowserAction): Promise<ActionResult> {
    this.touch();
    this.lastActionAt = Date.now();
    const page = this.page;
    let copied: string | undefined;
    switch (action.type) {
      case "navigate":
        await this.navigate(action.url);
        break;
      case "click": {
        const x = Math.min(action.x, this.width - 1);
        const y = Math.min(action.y, this.height - 1);
        if (this.device === "mobile") {
          for (let i = 0; i < action.clickCount; i++) await page.touchscreen.tap(x, y);
        } else {
          await page.mouse.click(x, y, { button: action.button, clickCount: action.clickCount });
        }
        break;
      }
      case "type":
        // Long text (a paste) goes in as one insertion rather than hundreds of key events.
        if (action.text.length > 64) await page.keyboard.insertText(action.text);
        else await page.keyboard.type(action.text);
        break;
      case "key":
        if (action.key === "Control+C") {
          copied = await this.selectionText();
          this.clipboard = copied;
        } else if (action.key === "Control+V") {
          // The session's own clipboard: Chromium's is shared by every session in the process.
          if (this.clipboard) await page.keyboard.insertText(this.clipboard);
        } else {
          await page.keyboard.press(action.key);
        }
        break;
      case "scroll":
        if (action.x !== undefined && action.y !== undefined) {
          await page.mouse.move(Math.min(action.x, this.width - 1), Math.min(action.y, this.height - 1));
        }
        await page.mouse.wheel(action.dx, action.dy);
        break;
      case "back":
        await page.goBack({ waitUntil: "commit", timeout: NAV_TIMEOUT_MS }).catch((e) => this.navFailed(e));
        break;
      case "forward":
        await page.goForward({ waitUntil: "commit", timeout: NAV_TIMEOUT_MS }).catch((e) => this.navFailed(e));
        break;
      case "reload":
        await page.reload({ waitUntil: "commit", timeout: NAV_TIMEOUT_MS }).catch((e) => this.navFailed(e));
        break;
    }
    await this.refreshState();
    return { ...this.state(), ...(copied !== undefined ? { copied } : {}) };
  }

  async navigate(input: string): Promise<void> {
    const target = normaliseTarget(input);
    const verdict = await this.guard.check(target);
    if (!verdict.ok) throw new BlockedAddressError(new URL(target).hostname, verdict.reason);
    this.lastRequestedUrl = target;
    this.error = undefined;
    await this.page.goto(target, { waitUntil: "commit", timeout: NAV_TIMEOUT_MS }).catch((e) => this.navFailed(e));
  }

  private navFailed(err: unknown): void {
    const name = netErrorName(err);
    if (name !== "ERR_ABORTED") this.error = name;
    this.loadingSince = null;
  }

  private selectionText(): Promise<string> {
    return this.page.evaluate<string>(selectionScript(CLIPBOARD_MAX)).catch(() => "");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => undefined);
  }
}

