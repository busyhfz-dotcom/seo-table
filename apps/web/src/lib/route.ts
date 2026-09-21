/**
 * One wrapper for every API route: authentication (session cookie or API key),
 * per-identity rate limiting, permission check, zod body validation, and a single
 * error-to-response mapping so no route leaks a stack trace.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z, type ZodType } from "zod";
import {
  apiLimit,
  assertCan,
  BadRequest,
  childLogger,
  errorToResponse,
  isAppError,
  newToken,
  Unauthorized,
  type Permission,
} from "@seo/core";
import { authenticateApiKey, currentSession, type Session } from "./auth";

export type Ctx<B = unknown> = {
  req: NextRequest;
  session: Session;
  body: B;
  params: Record<string, string>;
  correlationId: string;
  ip: string;
};

type Options<B> = {
  permission?: Permission;
  schema?: ZodType<B>;
  /** Routes that must work before login (the login route itself). */
  public?: boolean;
  /** Opt out of rate limiting for probes. */
  noRateLimit?: boolean;
};

export function handler<B = unknown>(
  options: Options<B>,
  fn: (ctx: Ctx<B>) => Promise<NextResponse | unknown>,
) {
  return async function route(
    req: NextRequest,
    context: { params: Promise<Record<string, string>> },
  ): Promise<NextResponse> {
    const correlationId = req.headers.get("x-correlation-id") ?? newToken(8);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const log = childLogger({ component: "api", path: req.nextUrl.pathname, correlationId });

    try {
      let session: Session | null = null;
      if (!options.public) {
        session = (await currentSession()) ?? (await authenticateApiKey(req.headers.get("authorization")));
        if (!session) throw new Unauthorized();
        if (!options.noRateLimit) await apiLimit(session.userId);
        if (options.permission) assertCan(session.role, options.permission);
      }

      let body = undefined as B;
      if (options.schema) {
        const raw = await readJson(req);
        const parsed = options.schema.safeParse(raw);
        if (!parsed.success) {
          throw new BadRequest("The request body is not valid", {
            issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          });
        }
        body = parsed.data;
      }

      const params = (await context?.params) ?? {};
      const result = await fn({
        req,
        session: session as Session,
        body,
        params,
        correlationId,
        ip,
      });

      if (result instanceof NextResponse) {
        result.headers.set("x-correlation-id", correlationId);
        return result;
      }
      return NextResponse.json(result ?? { ok: true }, {
        headers: { "x-correlation-id": correlationId },
      });
    } catch (err) {
      const { status, body } = errorToResponse(err);
      if (!isAppError(err)) {
        log.error({ err: (err as Error).message, stack: (err as Error).stack }, "unhandled route error");
      } else if (status >= 500) {
        log.error({ err: err.message, code: err.code }, "route error");
      } else {
        log.info({ code: err.code, status }, "route rejected");
      }
      const res = NextResponse.json(body, { status });
      res.headers.set("x-correlation-id", correlationId);
      if (status === 429 && isAppError(err)) {
        const retry = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
        if (retry) res.headers.set("retry-after", String(retry));
      }
      return res;
    }
  };
}

async function readJson(req: NextRequest): Promise<unknown> {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest("The request body is not valid JSON");
  }
}

export const idParam = z.string().min(1).max(40);

/** Parse ?page=&perPage= into SQL-friendly limits, with sane caps. */
export function pagination(req: NextRequest, defaultPerPage = 50) {
  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page") ?? 1) || 1);
  const perPage = Math.min(
    200,
    Math.max(1, Number(req.nextUrl.searchParams.get("perPage") ?? defaultPerPage) || defaultPerPage),
  );
  return { page, perPage, limit: perPage, offset: (page - 1) * perPage };
}
