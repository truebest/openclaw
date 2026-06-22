/**
 * Public Fluxer runtime API barrel used by plugin tests, docs, and integration
 * code that should not reach into src internals.
 */
export {
  DEFAULT_ACCOUNT_ID,
  listEnabledFluxerAccounts,
  listFluxerAccountIds,
  resolveDefaultFluxerAccountId,
  resolveFluxerAccount,
} from "./src/accounts.js";
export { fluxerPlugin } from "./src/channel.js";
export { fluxerConfigSchema } from "./src/config-schema.js";
export {
  attachFluxerGatewaySocket,
  decodeFluxerGatewayPayload,
  startFluxerGatewayAccount,
} from "./src/gateway.js";
export { createFluxerClient, normalizeFluxerApiBaseUrl } from "./src/http-client.js";
export { FLUXER_MESSAGE_CONTENT_LIMIT } from "./src/limits.js";
export { getFluxerRuntime, setFluxerRuntime } from "./src/runtime.js";
export { sendFluxerText } from "./src/outbound.js";
export {
  buildFluxerTarget,
  looksLikeFluxerTarget,
  parseFluxerTarget,
  normalizeFluxerTarget,
} from "./src/target.js";
export type {
  FluxerAccountConfig,
  FluxerChannel,
  FluxerConfig,
  FluxerGatewayBotResponse,
  FluxerGatewayPayload,
  FluxerGroupConfig,
  FluxerMessage,
  FluxerTarget,
  FluxerUser,
  CoreConfig,
  ResolvedFluxerAccount,
} from "./src/types.js";
