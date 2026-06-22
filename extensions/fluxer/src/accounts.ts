/**
 * Resolves Fluxer account configuration from root channel config, named account
 * overrides, and secret-provider references.
 */
import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { resolveDefaultSecretProviderAlias } from "openclaw/plugin-sdk/provider-auth";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeFluxerApiBaseUrl } from "./http-client.js";
import type {
  CoreConfig,
  FluxerAccountConfig,
  FluxerDmPolicy,
  FluxerGroupPolicy,
  ResolvedFluxerAccount,
} from "./types.js";

const DEFAULT_RECONNECT_MS = 1_500;
const MIN_RECONNECT_MS = 100;
const MAX_RECONNECT_MS = 60_000;
const FLUXER_BOT_TOKEN_ENV = "FLUXER_BOT_TOKEN";
const FLUXER_TOKEN_USER_ID_PATTERN = /^(\d{15,32})(?:[.\s]|$)/;

const {
  listAccountIds: listFluxerAccountIds,
  resolveDefaultAccountId: resolveDefaultFluxerAccountId,
} = createAccountListHelpers("fluxer", {
  normalizeAccountId,
  hasImplicitDefaultAccount: (cfg) => {
    const channel = cfg.channels?.fluxer;
    return Boolean(channel?.baseUrl?.trim());
  },
});

export { DEFAULT_ACCOUNT_ID, listFluxerAccountIds, resolveDefaultFluxerAccountId };

function resolveMergedFluxerAccountConfig(cfg: CoreConfig, accountId: string): FluxerAccountConfig {
  return resolveMergedAccountConfig<FluxerAccountConfig>({
    channelConfig: cfg.channels?.fluxer as FluxerAccountConfig | undefined,
    accounts: cfg.channels?.fluxer?.accounts,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
  });
}

function defaultFluxerTokenRef(cfg: CoreConfig) {
  return {
    source: "env" as const,
    provider: resolveDefaultSecretProviderAlias({ secrets: cfg.secrets }, "env"),
    id: FLUXER_BOT_TOKEN_ENV,
  };
}

function resolveFluxerToken(params: {
  cfg: CoreConfig;
  value: unknown;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const value = params.value ?? defaultFluxerTokenRef(params.cfg);
  const path =
    params.accountId === DEFAULT_ACCOUNT_ID
      ? "channels.fluxer.token"
      : `channels.fluxer.accounts.${params.accountId}.token`;
  const resolved = resolveSecretInputString({
    value,
    path,
    defaults: params.cfg.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status !== "available") {
    if (resolved.status === "configured_unavailable" && resolved.ref.source === "env") {
      const providerConfig = params.cfg.secrets?.providers?.[resolved.ref.provider];
      if (providerConfig) {
        if (providerConfig.source !== "env") {
          throw new Error(
            `Secret provider "${resolved.ref.provider}" has source "${providerConfig.source}" but ref requests "env".`,
          );
        }
        if (providerConfig.allowlist && !providerConfig.allowlist.includes(resolved.ref.id)) {
          throw new Error(
            `Environment variable "${resolved.ref.id}" is not allowlisted in secrets.providers.${resolved.ref.provider}.allowlist.`,
          );
        }
      } else if (
        resolved.ref.provider !==
        resolveDefaultSecretProviderAlias({ secrets: params.cfg.secrets }, "env")
      ) {
        throw new Error(
          `Secret provider "${resolved.ref.provider}" is not configured (ref: env:${resolved.ref.provider}:${resolved.ref.id}).`,
        );
      }
      return normalizeSecretInputString((params.env ?? process.env)[resolved.ref.id]) ?? "";
    }
    return "";
  }
  return normalizeResolvedSecretInputString({ value: resolved.value, path }) ?? "";
}

function normalizeDmPolicy(value: FluxerDmPolicy | undefined): FluxerDmPolicy {
  return value === "open" || value === "allowlist" || value === "disabled" || value === "pairing"
    ? value
    : "pairing";
}

function normalizeGroupPolicy(value: FluxerGroupPolicy | undefined): FluxerGroupPolicy {
  return value === "open" || value === "disabled" || value === "allowlist" ? value : "allowlist";
}

function normalizeBaseUrl(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, "") ?? "";
}

export function inferFluxerBotUserIdFromToken(token: string): string | undefined {
  const value = token.trim().replace(/^Bot\s+/i, "");
  return value.match(FLUXER_TOKEN_USER_ID_PATTERN)?.[1];
}

/**
 * Builds the normalized account snapshot used by gateway, outbound delivery,
 * status reporting, and channel routing.
 */
export function resolveFluxerAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): ResolvedFluxerAccount {
  const accountId = normalizeAccountId(params.accountId);
  const merged = resolveMergedFluxerAccountConfig(params.cfg, accountId);
  const baseEnabled = params.cfg.channels?.fluxer?.enabled !== false;
  const enabled = baseEnabled && merged.enabled !== false;
  const baseUrl = normalizeBaseUrl(merged.baseUrl);
  const apiBaseUrl = normalizeFluxerApiBaseUrl({
    baseUrl,
    apiBaseUrl: merged.apiBaseUrl,
  });
  const token = resolveFluxerToken({
    cfg: params.cfg,
    value: merged.token,
    accountId,
    env: params.env,
  });
  return {
    accountId,
    enabled,
    configured: Boolean(baseUrl && apiBaseUrl && token),
    name: normalizeOptionalString(merged.name),
    baseUrl,
    apiBaseUrl,
    gatewayUrl: normalizeOptionalString(merged.gatewayUrl),
    token,
    botUserId: normalizeOptionalString(merged.botUserId) ?? inferFluxerBotUserIdFromToken(token),
    agentId: normalizeOptionalString(merged.agentId),
    defaultTo: normalizeOptionalString(merged.defaultTo),
    dmPolicy: normalizeDmPolicy(merged.dmPolicy),
    allowFrom: merged.allowFrom ?? [],
    groupPolicy: normalizeGroupPolicy(merged.groupPolicy),
    groupAllowFrom: merged.groupAllowFrom ?? [],
    requireMention: merged.requireMention ?? true,
    groups: merged.groups ?? {},
    reconnectMs: resolveIntegerOption(merged.reconnectMs, DEFAULT_RECONNECT_MS, {
      min: MIN_RECONNECT_MS,
      max: MAX_RECONNECT_MS,
    }),
    config: {
      ...merged,
      allowFrom: merged.allowFrom ?? [],
      groupAllowFrom: merged.groupAllowFrom ?? [],
      groups: merged.groups ?? {},
    },
  };
}

/**
 * Returns all enabled accounts, including the implicit default account when
 * top-level Fluxer config is present.
 */
export function listEnabledFluxerAccounts(cfg: CoreConfig): ResolvedFluxerAccount[] {
  return listFluxerAccountIds(cfg)
    .map((accountId) => resolveFluxerAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
