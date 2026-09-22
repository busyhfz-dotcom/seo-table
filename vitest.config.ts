import path from "node:path";
import { defineConfig } from "vitest/config";

const root = __dirname;

export default defineConfig({
  resolve: {
    alias: {
      "@seo/db": path.resolve(root, "packages/db/src/index.ts"),
      "@seo/core": path.resolve(root, "packages/core/src/index.ts"),
      "@seo/connectors": path.resolve(root, "packages/connectors/src/index.ts"),
      "@seo/pipeline": path.resolve(root, "packages/pipeline/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false },
    // A test run must never share queues with a worker that happens to be running.
    env: { NODE_ENV: "test", QUEUE_PREFIX: process.env.TEST_QUEUE_PREFIX ?? "seo-test" },
  },
});
