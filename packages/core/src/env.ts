/**
 * Every secret and tunable enters the process here and nowhere else.
 * Validation runs at import time, so a misconfigured deployment fails at
 * startup with a readable message instead of at the first request.
 */
import { z } from "zod";

const hex64 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (openssl rand -hex 32)");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .string()
    .url()
    .refine((u) => /^postgres(ql)?:\/\//i.test(u), "must be a postgres:// or postgresql:// URL"),
  REDIS_URL: z
    .string()
    .url()
    .refine((u) => /^rediss?:\/\//i.test(u), "must be a redis:// or rediss:// URL"),
  ENCRYPTION_KEY: hex64,
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
  /**
   * Public origin, informational only (nothing derives redirects from it). Optional
   * so a first deploy whose public domain does not exist yet can still boot; a
   * bare scheme is what `https://${{RAILWAY_PUBLIC_DOMAIN}}` renders to before
   * the domain is created, and counts as unset rather than crash-looping.
   */
  APP_URL: z.preprocess(
    (v) => (typeof v === "string" && /^https?:\/\/$/i.test(v) ? undefined : v),
    z.string().url().optional(),
  ),

  LOG_LEVEL: z.preprocess(
    (v) => (typeof v === "string" ? v.toLowerCase() : v),
    z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  ),
  CRAWLER_USER_AGENT: z.string().default("SeoTableBot/0.4 (+https://seo-table.app/bot)"),
  CRAWLER_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  CRAWLER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  CRAWLER_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(5),

  SCAN_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).default(10),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),

  /** Hard ceiling on writes per fix execution. The safety policy cannot exceed it. */
  MAX_CHANGES_PER_EXECUTION: z.coerce.number().int().min(1).max(1000).default(50),
  QUEUE_PREFIX: z.string().regex(/^[a-z0-9_-]+$/i).default("seo"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),

  PORT: z.coerce.number().int().min(1).max(65535).optional(),
});

export type Env = z.infer<typeof schema>;

/**
 * Values are trimmed and blank ones treated as unset: a variable pasted from a
 * Windows shell can carry a trailing "\r" (which would make a 64-hex key 65
 * characters), and a variable set to "" should mean "use the default", not
 * "PORT=0".
 */
function normalised(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const trimmed = value?.trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

function load(): Env {
  const parsed = schema.safeParse(normalised(process.env));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  if (parsed.data.NODE_ENV === "production") {
    if (parsed.data.ENCRYPTION_KEY === "0".repeat(64)) {
      throw new Error("ENCRYPTION_KEY is still the placeholder value; generate a real key");
    }
    if (/change-me/i.test(parsed.data.SESSION_SECRET)) {
      throw new Error("SESSION_SECRET is still the placeholder value; generate a real secret");
    }
  }
  return parsed.data;
}

let cached: Env | undefined;

export function env(): Env {
  cached ??= load();
  return cached;
}

/** Test helper: forget the cached environment so a new one can be validated. */
export function resetEnvCache(): void {
  cached = undefined;
}
