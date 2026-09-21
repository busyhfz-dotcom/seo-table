/**
 * Structured logging. Secrets are redacted by key, so an accidental
 * `log.info({ connector })` cannot leak a credential into a log drain.
 */
import pino from "pino";
import { env } from "./env.js";

export const logger = pino({
  level: env().LOG_LEVEL,
  base: { service: process.env.SERVICE_NAME ?? "seo-table" },
  redact: {
    paths: [
      "password",
      "passwordHash",
      "token",
      "tokenHash",
      "secret",
      "secretCipher",
      "secretIv",
      "secretTag",
      "applicationPassword",
      "credentials",
      "authorization",
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.secret",
      "*.token",
    ],
    censor: "[redacted]",
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

export type Logger = typeof logger;

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings) as Logger;
}

/** Monitoring hook: one counter/timer sink the host platform can scrape or drain. */
export type Metric = { name: string; value: number; tags?: Record<string, string> };

const metricSinks: Array<(m: Metric) => void> = [
  (m) => logger.debug({ metric: m.name, value: m.value, ...m.tags }, "metric"),
];

export function onMetric(sink: (m: Metric) => void): void {
  metricSinks.push(sink);
}

export function metric(name: string, value = 1, tags?: Record<string, string>): void {
  for (const sink of metricSinks) {
    try {
      sink({ name, value, tags });
    } catch {
      /* a broken sink must never break the request */
    }
  }
}

export async function timed<T>(
  name: string,
  fn: () => Promise<T>,
  tags?: Record<string, string>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const out = await fn();
    metric(`${name}.ms`, Date.now() - t0, { ...tags, outcome: "ok" });
    return out;
  } catch (err) {
    metric(`${name}.ms`, Date.now() - t0, { ...tags, outcome: "error" });
    throw err;
  }
}
