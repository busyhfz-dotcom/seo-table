/**
 * One wrapper for every API route: authentication (session cookie or API key),
 * cross-site and content-type checks, per-identity rate limiting, permission
 * check, zod body validation, and a single error-to-response mapping so no route
 * leaks a stack trace and every error body is `{ error: { code, message, details? } }`.
 */
import { NextResponse, type NextRequest } from "next/server";
import type { ZodType } from "zod";
import {
  apiLimit,
  AppError,
  assertCan,
  BadRequest,
  childLogger,
  errorToResponse,
  Forbidden,
  isAppError,
  newToken,
  Unauthorized,
  type Actor,
  type Permission,
} from "@seo/core";
import { actorFor, authenticateApiKey, currentSession, type Session } from "./auth";
import {
  clientIp,
  isCrossSite,
  isJsonContentType,
  isValidIdempotencyKey,
  parsePagination,
} from "./request";

export type Ctx<B = unknown> = {
  req: NextRequest;
  session: Session;
  /** The audit actor for this caller (USER or API_KEY), with the client IP. */
  actor: Actor;
  body: B;
  params: Record<string, string>;
  correlationId: string;
  ip: string;
  /** True when the body arrived as an HTML form rather than JSON (see `acceptForm`). */
  isForm: boolean;
};

type Options<B> = {
  permission?: Permission;
  schema?: ZodType<B>;
  /** Routes that must work before login (the login route itself). */
  public?: boolean;
  /** Opt out of rate limiting for probes. */
  noRateLimit?: boolean;
  /** Only a browser session may call this (not an API key). */
  sessionOnly?: boolean;
  /** Also accept an urlencoded/multipart body, for plain HTML forms that work without JavaScript. */
  acceptForm?: boolean;
};

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

class UnsupportedMediaType extends AppError {
  constructor() {
    super(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request body as application/json");
  }
}

export function handler<B = unknown>(
  options: Options<B>,
  fn: (ctx: Ctx<B>) => Promise<NextResponse | unknown>,
) {
  return async function route(
    req: NextRequest,
    context: { params: Promise<Record<string, string>> },
  ): Promise<NextResponse> {
    const correlationId = req.headers.get("x-correlation-id") ?? newToken(8);
    const ip = clientIp(req.headers);
    const log = childLogger({ component: "api", path: req.nextUrl.pathname, correlationId });

    try {
      // A bearer token means a machine caller: it is authenticated by the key
      // alone (a bad key is a 401, never a fallback to the cookie), and a key
      // cannot be ridden cross-site the way a cookie can.
      const authorization = req.headers.get("authorization");
      const viaKey = Boolean(authorization?.startsWith("Bearer "));
      if (UNSAFE.has(req.method) && !viaKey && isCrossSite(req.headers)) {
        throw new Forbidden("Cross-site requests are not allowed");
      }

      // Validated before anything is spent on the request, including the rate limit.
      const idempotencyKey = req.headers.get("idempotency-key");
      if (idempotencyKey !== null && !isValidIdempotencyKey(idempotencyKey)) {
        throw new BadRequest("Idempotency-Key must be 1–255 visible ASCII characters");
      }

      let session: Session | null = null;
      if (!options.public) {
        session = viaKey ? await authenticateApiKey(authorization) : await currentSession();
        if (!session) throw new Unauthorized();
        if (options.sessionOnly && session.via !== "session") {
          throw new Forbidden("This action needs a signed-in person, not an API key");
        }
        if (!options.noRateLimit) await apiLimit(session.userId);
        if (options.permission) assertCan(session.role, options.permission);
      }

      let body = undefined as B;
      let isForm = false;
      if (options.schema) {
        const read = await readBody(req, options.acceptForm ?? false);
        isForm = read.isForm;
        const parsed = options.schema.safeParse(read.value);
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
        actor: session ? actorFor(session, ip) : { type: "USER", id: null, ip },
        body,
        params,
        correlationId,
        ip,
        isForm,
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

/**
 * An empty body is `{}` (so schemas with defaults work for a bare POST); any
 * other body must declare a JSON content type. That, together with the
 * cross-site check, keeps a `text/plain` form post from another site out.
 */
async function readBody(req: NextRequest, acceptForm: boolean): Promise<{ value: unknown; isForm: boolean }> {
  const type = req.headers.get("content-type");
  const mediaType = type?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (acceptForm && (mediaType === "application/x-www-form-urlencoded" || mediaType === "multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new BadRequest("The form body could not be read");
    }
    const value: Record<string, string> = {};
    form.forEach((v, k) => {
      if (typeof v === "string") value[k] = v;
    });
    return { value, isForm: true };
  }

  const text = await req.text();
  if (!text) return { value: {}, isForm: false };
  if (!isJsonContentType(type)) throw new UnsupportedMediaType();
  try {
    return { value: JSON.parse(text), isForm: false };
  } catch {
    throw new BadRequest("The request body is not valid JSON");
  }
}

/** Parse ?page=&perPage= into SQL-friendly limits: page 1..1e6, perPage 1..200. */
export function pagination(req: NextRequest, defaultPerPage = 50) {
  return parsePagination(req.nextUrl.searchParams, defaultPerPage);
}
