// Vitest extension fluxer config wires the extension fluxer test shard.
import { createSingleChannelExtensionVitestConfig } from "./vitest.extension-channel-single-config.ts";

export function createExtensionFluxerVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createSingleChannelExtensionVitestConfig("fluxer", env);
}

export default createExtensionFluxerVitestConfig();
