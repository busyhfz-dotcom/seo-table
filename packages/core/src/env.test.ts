import { afterEach, describe, expect, it } from "vitest";
import { env, resetEnvCache } from "./env.js";

const saved = { ...process.env };

const production = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://u:p@ep-x-123.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full",
  REDIS_URL: "rediss://default:p@redis.example:6380",
  ENCRYPTION_KEY: "ab".repeat(32),
  SESSION_SECRET: "s".repeat(64),
};

function load(vars: Record<string, string>) {
  for (const key of ["APP_URL", "PORT", "LOG_LEVEL"]) delete process.env[key];
  Object.assign(process.env, production, vars);
  resetEnvCache();
  return env();
}

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  resetEnvCache();
});

describe("env", () => {
  it("accepts a production configuration with TLS Postgres and Redis", () => {
    const e = load({});
    expect(e.DATABASE_URL).toContain("sslmode=verify-full");
    expect(e.REDIS_URL.startsWith("rediss://")).toBe(true);
    expect(e.APP_URL).toBeUndefined();
  });

  it("trims secrets pasted with a Windows line ending", () => {
    const e = load({ ENCRYPTION_KEY: `${"ab".repeat(32)}\r`, SESSION_SECRET: `${"s".repeat(64)}\r\n` });
    expect(e.ENCRYPTION_KEY).toBe("ab".repeat(32));
    expect(e.SESSION_SECRET).toBe("s".repeat(64));
  });

  it("treats a blank or scheme-only APP_URL as unset instead of failing to boot", () => {
    expect(load({ APP_URL: "" }).APP_URL).toBeUndefined();
    // What https://${{RAILWAY_PUBLIC_DOMAIN}} renders to before the domain exists.
    expect(load({ APP_URL: "https://" }).APP_URL).toBeUndefined();
    expect(load({ APP_URL: " https://app.example.ir " }).APP_URL).toBe("https://app.example.ir");
    expect(() => load({ APP_URL: "not a url" })).toThrow(/APP_URL/);
  });

  it("uses defaults for blank values and accepts upper-case log levels", () => {
    const e = load({ PORT: "", LOG_LEVEL: "WARN" });
    expect(e.PORT).toBeUndefined();
    expect(e.LOG_LEVEL).toBe("warn");
    expect(() => load({ PORT: "70000" })).toThrow(/PORT/);
  });

  it("rejects a non-Postgres database URL", () => {
    expect(() => load({ DATABASE_URL: "mysql://u:p@h/db" })).toThrow(/DATABASE_URL/);
  });
});
