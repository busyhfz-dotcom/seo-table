import { BadRequest } from "@seo/core";
import { discovery, isSupportedCountry } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { costLimit, projectFor, providerCall } from "../../../../../../lib/seo-data";

/**
 * GET ?seed=…&locale=fa&country=IR → Google autocomplete suggestions, cached 7
 * days. No volume data: the response says so (volumeData:false).
 */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await projectFor(session, params.id);
  const p = req.nextUrl.searchParams;
  const seed = (p.get("seed") ?? "").trim();
  if (!seed || seed.length > 100) throw new BadRequest("seed is required (1–100 characters)");
  const locale = p.get("locale") ?? project.locale;
  const country = (p.get("country") ?? "IR").toUpperCase();
  if (!/^[a-z]{2}$/.test(locale) || !isSupportedCountry(country)) throw new BadRequest("Unsupported locale or country");
  await costLimit(`suggest:${session.userId}`, 30, 60_000);
  return providerCall(() => discovery.suggestions(project.id, seed, { locale, country }));
});
