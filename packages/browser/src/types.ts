/**
 * The shapes that cross the worker's internal browser API (contract K3). The web
 * proxy mirrors them; zod schemas validate every body the worker receives.
 */
import { z } from "zod";

export const DEVICES = ["desktop", "mobile"] as const;
export type Device = (typeof DEVICES)[number];

/** Keys a remote user may press. Anything else could reach browser shortcuts. */
export const ALLOWED_KEYS = [
  "Enter",
  "Tab",
  "Shift+Tab",
  "Backspace",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Delete",
  "Control+A",
  "Control+C",
  "Control+V",
] as const;
export type AllowedKey = (typeof ALLOWED_KEYS)[number];

const coord = z.number().finite().min(0).max(10_000);
const delta = z.number().finite().min(-10_000).max(10_000);

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().trim().min(1).max(2048) }),
  z.object({
    type: z.literal("click"),
    x: coord,
    y: coord,
    button: z.enum(["left", "right", "middle"]).default("left"),
    clickCount: z.number().int().min(1).max(3).default(1),
  }),
  z.object({ type: z.literal("type"), text: z.string().min(1).max(2000) }),
  z.object({ type: z.literal("key"), key: z.enum(ALLOWED_KEYS) }),
  z.object({ type: z.literal("scroll"), dx: delta.default(0), dy: delta.default(0), x: coord.optional(), y: coord.optional() }),
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("forward") }),
  z.object({ type: z.literal("reload") }),
]);
export type BrowserAction = z.infer<typeof actionSchema>;
export type BrowserActionInput = z.input<typeof actionSchema>;

export const LOCALES = ["fa", "en"] as const;

export const createSessionSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  device: z.enum(DEVICES).default("desktop"),
  /** Language of the pages the browser itself shows (the blocked-address page). */
  locale: z.enum(LOCALES).default("fa"),
});

/** Fields a "preview of the fix" can change in the rendered DOM. */
export const CHANGE_FIELDS = ["title", "meta_description", "canonical", "robots", "h1", "img_alt", "jsonld"] as const;
export type ChangeField = (typeof CHANGE_FIELDS)[number];

export const changeSchema = z
  .object({
    field: z.enum(CHANGE_FIELDS),
    value: z.string().max(20_000),
    /** For img_alt: the image's src (as written in the HTML or absolute). */
    selector: z.string().max(2048).optional(),
  })
  .refine((c) => c.field !== "img_alt" || Boolean(c.selector), {
    message: "img_alt needs the image src as selector",
    path: ["selector"],
  });
export type PageChange = z.infer<typeof changeSchema>;

export const renderSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  device: z.enum(DEVICES).default("desktop"),
  changes: z.array(changeSchema).max(50).optional(),
  locale: z.enum(LOCALES).default("fa"),
});
export type RenderInput = z.input<typeof renderSchema>;

export type Owner = { orgId: string; userId: string };

export type PageState = {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Short network error name of the last failed navigation, e.g. "ERR_NAME_NOT_RESOLVED". */
  error?: string;
};

export type SessionInfo = PageState & { id: string; width: number; height: number; device: Device };

export type ActionResult = PageState & {
  /** Text copied by Control+C, so the panel can put it on the viewer's own clipboard. */
  copied?: string;
};

export type Frame =
  | { notModified: true; etag: string; state: PageState }
  | { notModified: false; etag: string; state: PageState; body: Buffer };

export type SeoData = {
  title: string | null;
  description: string | null;
  canonical: string | null;
  robots: string | null;
  h1: string[];
  hreflang: Array<{ lang: string; href: string }>;
  jsonld: string[];
  links: { internal: number; external: number };
  lang: string | null;
  wordCount: number;
  imagesMissingAlt: number;
};

export type ConsoleEntry = { type: "error" | "exception"; text: string; source?: string };

export type RenderResult = {
  url: string;
  finalUrl: string;
  status: number | null;
  device: Device;
  /** The page never went network-idle within the time limit; data is what had loaded by then. */
  timedOut: boolean;
  screenshot: string;
  width: number;
  height: number;
  seo: SeoData;
  console: ConsoleEntry[];
  metrics: { lcpMs?: number; cls?: number; ttfbMs?: number };
  renderedVsRaw: {
    /** False when the raw HTML could not be fetched; the comparison is then empty. */
    available: boolean;
    titleDiffers: boolean;
    descriptionDiffers: boolean;
    canonicalDiffers: boolean;
    robotsDiffers: boolean;
    h1Differs: boolean;
    linksOnlyInRendered: number;
    rawLinks: number;
    renderedLinks: number;
  };
  blockedRequests: number;
  changesApplied: number;
};
