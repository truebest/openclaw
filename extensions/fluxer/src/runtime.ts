/**
 * Runtime store for host-provided OpenClaw services used by the Fluxer bundled
 * plugin.
 */
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setFluxerRuntime, getRuntime: getFluxerRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "fluxer",
    errorMessage: "Fluxer runtime not initialized",
  });

export { getFluxerRuntime, setFluxerRuntime };
