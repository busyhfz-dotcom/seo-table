/**
 * The slice of Workers KV the tests use. Miniflare types its bindings with
 * @cloudflare/workers-types, which this repository does not install.
 */
import type { Miniflare } from "miniflare";

export type TestKv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string }): Promise<{ keys: Array<{ name: string }> }>;
};

export async function miniflareKv(mf: Miniflare, binding = "RULES"): Promise<TestKv> {
  return (await mf.getKVNamespace(binding)) as unknown as TestKv;
}
