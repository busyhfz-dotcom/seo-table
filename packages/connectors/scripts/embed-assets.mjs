/**
 * Embeds files the connectors ship to customers as string modules, so they are
 * served byte-for-byte under any bundler (Next's webpack cannot read a
 * sibling file at runtime):
 *   - src/edge/worker.js + keys.js → src/edge/worker-source.ts (uploaded to Cloudflare)
 *   - wordpress-plugin/seo-table-bridge.php → src/bridge-plugin-source.ts (downloaded by site owners)
 * Run after editing any of them; a test fails while the copies disagree.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const header = (from) => [
  `// GENERATED from ${from} by scripts/embed-assets.mjs — do not edit by hand.`,
  "// Regenerate with: pnpm --filter @seo/connectors embed-assets",
  "",
];

const modules = { "worker.js": read("src/edge/worker.js"), "keys.js": read("src/edge/keys.js") };
const hash = createHash("sha256");
for (const [name, source] of Object.entries(modules)) hash.update(`${name}\0${source}\0`);
const version = hash.digest("hex").slice(0, 16);
writeFileSync(
  new URL("src/edge/worker-source.ts", root),
  [
    ...header("worker.js and keys.js"),
    "/** The worker's ES modules by file name; worker.js is the main module. */",
    `export const WORKER_MODULES: Readonly<Record<"worker.js" | "keys.js", string>> = ${JSON.stringify(modules, null, 2)};`,
    "",
    "/** Identifies this build of the worker; stored in KV at install so the panel can tell an outdated edge. */",
    `export const WORKER_VERSION = ${JSON.stringify(version)};`,
    "",
  ].join("\n"),
);

const plugin = read("wordpress-plugin/seo-table-bridge.php");
const pluginVersion = /^\s*\*\s*Version:\s*(\S+)/m.exec(plugin)?.[1] ?? "unknown";
writeFileSync(
  new URL("src/bridge-plugin-source.ts", root),
  [
    ...header("wordpress-plugin/seo-table-bridge.php"),
    `export const BRIDGE_PLUGIN_SOURCE: string = ${JSON.stringify(plugin)};`,
    `export const BRIDGE_PLUGIN_VERSION = ${JSON.stringify(pluginVersion)};`,
    "",
  ].join("\n"),
);
console.log(`embedded worker ${version} and bridge plugin ${pluginVersion}`);
