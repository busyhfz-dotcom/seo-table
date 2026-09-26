/**
 * The SEO Table bridge plugin as the zip WordPress's "Plugins → Add New →
 * Upload Plugin" screen accepts: one folder holding the plugin file.
 */
import { zipSync } from "fflate";
import { BRIDGE_PLUGIN_SOURCE, BRIDGE_PLUGIN_VERSION } from "./bridge-plugin-source.js";

export { BRIDGE_PLUGIN_VERSION };

export function bridgePluginZip(): Uint8Array {
  return zipSync({ "seo-table-bridge/seo-table-bridge.php": new TextEncoder().encode(BRIDGE_PLUGIN_SOURCE) }, { level: 6 });
}
