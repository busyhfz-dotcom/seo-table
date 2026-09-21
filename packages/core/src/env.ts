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
  DATABASE_URL: z.string().url().refine((u) => u.startsWith("postgres"), "must be a postgres:// URL"),
  REDIS_URL: z.string().url().refine((u) => u.startsWith("redis"), "must be a redis:// URL"),
  ENCRYPTION_KEY: hex64,
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
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

  PORT: z.coerce.number().int().optional(),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
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
