/**
 * What every Instagram / Telegram screen's server page starts from: the
 * project (which must be a social one — a website lands on its dashboard), the
 * reader's permissions, and the platform's reason codes already worded in the
 * reader's language, so client components never show a raw code.
 */
import { redirect } from "next/navigation";
import { can, env } from "@seo/core";
import { SOCIAL_REASON_CODES, socialReasonText } from "@seo/social";
import { pageContext, withProject, type PageContext } from "../../../lib/page";
import { COMMON } from "../../../lib/common-strings";
import { SOCIAL } from "./strings";
import type { SocialCtx } from "./parts";

export async function socialScreen() {
  const pc = await pageContext();
  if (pc.project && pc.project.kind === "WEBSITE") redirect(withProject("/", pc.requestedProjectId));
  return { ...pc, ctx: socialCtx(pc), s: SOCIAL[pc.locale], c: COMMON[pc.locale] };
}

/** The social screens' context for the project on screen, or null when it is not a social project. */
export function socialCtx(pc: PageContext): SocialCtx | null {
  const { project, session, locale, requestedProjectId } = pc;
  if (!project || project.kind === "WEBSITE") return null;
  const reasons: Record<string, string> = {};
  for (const code of SOCIAL_REASON_CODES) reasons[code] = socialReasonText(code)![locale];
  const link = (path: string) => withProject(path, requestedProjectId);
  return {
    projectId: project.id,
    platform: project.kind,
    locale,
    reasons,
    links: {
      overview: link("/social"),
      audit: link("/social/audit"),
      analytics: link("/social/analytics"),
      posts: link("/social/posts"),
      planner: link("/social/planner"),
      competitors: link("/social/competitors"),
      fixes: link("/fixes"),
      approvals: link("/approvals"),
    },
    can: {
      write: can(session.role, "social:write"),
      connect: can(session.role, "connector:write") && session.via === "session",
      check: can(session.role, "connector:read"),
      approve: can(session.role, "fix:approve_sensitive") && session.via === "session",
    },
  };
}

/** Where Instagram sends the owner back, as it must be registered in the Meta app; null without APP_URL. */
export function instagramRedirectUri(): string | null {
  const appUrl = env().APP_URL;
  return appUrl ? new URL("/api/oauth/instagram/callback", appUrl).toString() : null;
}
