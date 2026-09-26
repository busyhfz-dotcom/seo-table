import { z } from "zod";
import { enforce } from "@seo/core";
import { handler } from "../../../../lib/route";
import { isLocale } from "../../../../lib/i18n";
import { callWorker, workerJson } from "../_lib/worker";

const schema = z.object({
  url: z.string().trim().min(1).max(2048),
  device: z.enum(["desktop", "mobile"]).default("desktop"),
  changes: z
    .array(
      z.object({
        field: z.string().max(40),
        value: z.string().max(20_000),
        selector: z.string().max(2048).optional(),
      }),
    )
    .max(50)
    .optional(),
});

/**
 * Render a URL in a fresh browser and report what a visitor's browser sees:
 * {screenshot (base64 JPEG), seo:{title, description, canonical, robots, h1[],
 * hreflang[], jsonld[], links:{internal, external}}, console[], metrics:{lcpMs,
 * cls, ttfbMs}, renderedVsRaw:{titleDiffers, descriptionDiffers,
 * linksOnlyInRendered, …}}.
 *
 * `changes` ([{field, value, selector?}], field one of title, meta_description,
 * canonical, robots, h1, img_alt (selector = image src), jsonld) are applied to
 * the rendered page before the screenshot: a preview of a fix, nothing is written.
 */
export const POST = handler({ permission: "project:read", schema }, async ({ req, session, body }) => {
  // A render is a whole page load in Chromium plus a second fetch of the HTML.
  await enforce(`browser:render:${session.userId}`, 10, 60_000, { failClosed: true });
  const cookie = req.cookies.get("locale")?.value;
  const res = await callWorker("/render", {
    method: "POST",
    caller: session,
    body: { ...body, locale: isLocale(cookie) ? cookie : "fa" },
    timeoutMs: 60_000,
  });
  return workerJson(res);
});
