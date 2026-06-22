/**
 * Bundled channel entry metadata for the Fluxer plugin.
 */
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "fluxer",
  name: "Fluxer",
  description: "Fluxer channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "fluxerPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setFluxerRuntime",
  },
});
