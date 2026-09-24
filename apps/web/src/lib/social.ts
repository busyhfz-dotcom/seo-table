/**
 * Shared pieces of the Instagram / Telegram routes.
 */
import type { NextRequest } from "next/server";
import { BadRequest } from "@seo/core";
import type { Project, SocialPlatform } from "@seo/db";
import { socialAccounts, socialReasonText } from "@seo/social";
import type { Session } from "./auth";
import { projectFor } from "./seo-data";

/** The project in the path, which must be an Instagram or Telegram project (of `platform`, when given). */
export async function socialProjectFor(session: Session, projectId: string | undefined, platform?: SocialPlatform): Promise<Project> {
  const project = await projectFor(session, projectId);
  socialAccounts.assertSocialProject(project, platform);
  return project;
}

/** A refusal the owner can act on: 200 {ok:false, reason, reasonText}, never a raw platform message. */
export function refusal(reason: string | null | undefined, extra: Record<string, unknown> = {}) {
  return { ok: false as const, reason: reason ?? "api_error", reasonText: socialReasonText(reason ?? "api_error"), ...extra };
}

/** ?from=&to= as instants (ISO date or date-time); defaults to the next `defaultDays` days from today. */
export function instantRange(req: NextRequest, defaultDays: number, back = 0): { from: Date; to: Date } {
  const p = req.nextUrl.searchParams;
  const now = Date.now();
  const parse = (v: string | null, fallback: number) => {
    if (!v) return new Date(fallback);
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw new BadRequest("from and to must be dates");
    return new Date(t);
  };
  const from = parse(p.get("from"), now - back * 86_400_000);
  const to = parse(p.get("to"), now + defaultDays * 86_400_000);
  if (from > to) throw new BadRequest("from must not be after to");
  if (to.getTime() - from.getTime() > 400 * 86_400_000) throw new BadRequest("The range may span at most 400 days");
  return { from, to };
}
