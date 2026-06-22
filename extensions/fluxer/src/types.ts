/**
 * Shared Fluxer config, runtime account, API object, gateway, and target types.
 */
import type {
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export type FluxerDmPolicy = "pairing" | "allowlist" | "open" | "disabled";
export type FluxerGroupPolicy = "allowlist" | "open" | "disabled";

/** Per-channel Fluxer group/community policy. */
export type FluxerGroupConfig = {
  enabled?: boolean;
  requireMention?: boolean;
  allowFrom?: string[];
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

/** User-configurable settings for one Fluxer account. */
export type FluxerAccountConfig = {
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  apiBaseUrl?: string;
  gatewayUrl?: string;
  token?: unknown;
  botUserId?: string;
  agentId?: string;
  defaultTo?: string;
  dmPolicy?: FluxerDmPolicy;
  allowFrom?: string[];
  groupPolicy?: FluxerGroupPolicy;
  groupAllowFrom?: string[];
  requireMention?: boolean;
  groups?: Record<string, FluxerGroupConfig>;
  reconnectMs?: number;
};

/** Root Fluxer channel config with optional named accounts. */
export type FluxerConfig = FluxerAccountConfig & {
  accounts?: Record<string, Partial<FluxerAccountConfig>>;
  defaultAccount?: string;
};

/** OpenClaw config narrowed to include Fluxer channel settings. */
export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    fluxer?: FluxerConfig;
  };
};

/** Normalized account snapshot consumed by runtime paths. */
export type ResolvedFluxerAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  baseUrl: string;
  apiBaseUrl: string;
  gatewayUrl?: string;
  token: string;
  botUserId?: string;
  agentId?: string;
  defaultTo?: string;
  dmPolicy: FluxerDmPolicy;
  allowFrom: string[];
  groupPolicy: FluxerGroupPolicy;
  groupAllowFrom: string[];
  requireMention: boolean;
  groups: Record<string, FluxerGroupConfig>;
  reconnectMs: number;
  config: FluxerAccountConfig;
};

/** User object returned by the Fluxer API and gateway. */
export type FluxerUser = {
  id: string;
  username?: string;
  global_name?: string | null;
  display_name?: string | null;
  name?: string | null;
  bot?: boolean;
};

/** Channel object returned by the Fluxer API and gateway. */
export type FluxerChannel = {
  id: string;
  type?: string | number;
  name?: string | null;
  guild_id?: string | null;
  community_id?: string | null;
  group_id?: string | null;
  server_id?: string | null;
};

/** Message object returned by Fluxer channel and DM endpoints. */
export type FluxerMessage = {
  id: string;
  channel_id: string;
  author?: FluxerUser | null;
  author_id?: string | null;
  content?: string | null;
  mentions?: Array<string | FluxerUser | { id?: string | null }> | null;
  channel?: FluxerChannel | null;
  channel_type?: string | number | null;
  guild_id?: string | null;
  community_id?: string | null;
  group_id?: string | null;
  server_id?: string | null;
  direct?: boolean;
  dm?: boolean;
  timestamp?: string;
  created_at?: string;
  message_reference?: {
    message_id?: string;
    channel_id?: string;
  } | null;
};

export type FluxerGatewayBotResponse = {
  url?: string;
  gateway_url?: string;
  shards?: number;
  session_start_limit?: unknown;
};

export type FluxerGatewayPayload = {
  op?: number | string;
  s?: number | string | null;
  seq?: number | string | null;
  t?: string | null;
  type?: string | null;
  d?: unknown;
};

/** Parsed outbound destination for Fluxer delivery. */
export type FluxerTarget =
  | { chatType: "group"; kind: "channel"; id: string }
  | { chatType: "direct"; kind: "dm"; id: string };
