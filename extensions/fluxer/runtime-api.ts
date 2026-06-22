/**
 * Public runtime injection surface used by the bundled Fluxer entry.
 */
export {
  type FluxerAccountConfig,
  type FluxerGatewayPayload,
  type FluxerMessage,
  type FluxerTarget,
  type ResolvedFluxerAccount,
  createFluxerClient,
  fluxerMessageActions,
  parseFluxerTarget,
  resolveFluxerAccount,
  setFluxerRuntime,
} from "./api.js";
