/**
 * Maps Fluxer senders and conversations onto the shared channel ingress
 * allowlist/command authorization contract.
 */
import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
  type ChannelIngressDecision,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  isFluxerGroupRouteAllowed,
  resolveFluxerGroupConfig,
  resolveFluxerGroupRequireMention,
} from "./group-policy.js";
import {
  fluxerMessageAuthorId,
  fluxerMessageContent,
  isFluxerDirectMessage,
  messageMentionsFluxerUser,
} from "./message.js";
import { getFluxerRuntime } from "./runtime.js";
import type { CoreConfig, FluxerMessage, ResolvedFluxerAccount } from "./types.js";

const CHANNEL_ID = "fluxer" as const;

function normalizeFluxerUserId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const withoutProvider = trimmed.replace(/^fluxer:/i, "").trim();
  const directTarget = withoutProvider.match(/^(?:user|dm):(.+)$/i);
  return directTarget?.[1]?.trim() || withoutProvider || null;
}

const fluxerIngressIdentity = defineStableChannelIngressIdentity({
  key: "fluxer-user-id",
  normalizeEntry: normalizeFluxerUserId,
  normalizeSubject: normalizeFluxerUserId,
  isWildcardEntry: (entry) => normalizeFluxerUserId(entry) === "*",
  entryIdPrefix: "fluxer-user",
});

export type FluxerInboundAccess = {
  shouldDispatch: boolean;
  commandAuthorized: boolean;
  hasAbortRequest: boolean;
  hasControlCommand: boolean;
  ingressAdmission: ChannelIngressDecision["admission"];
  wasMentioned?: boolean;
  isDirect: boolean;
};

/**
 * Resolves whether a Fluxer message should enter the agent pipeline and whether
 * its command-style body may run tools.
 */
export async function resolveFluxerInboundAccess(params: {
  account: ResolvedFluxerAccount;
  config: CoreConfig;
  message: FluxerMessage;
  botUserId?: string | null;
}): Promise<FluxerInboundAccess> {
  const runtime = getFluxerRuntime();
  const cfg = params.config as OpenClawConfig;
  const message = params.message;
  const isDirect = isFluxerDirectMessage(message);
  const content = fluxerMessageContent(message);
  const authorId = fluxerMessageAuthorId(message);
  const shouldCheckCommand = runtime.channel.commands.shouldComputeCommandAuthorized(content, cfg);
  const hasAbortRequest = isAbortRequestText(content);
  const command = shouldCheckCommand
    ? {
        cfg,
        allowTextCommands: true,
        hasControlCommand: true,
      }
    : false;
  const resolver = createChannelIngressResolver({
    channelId: CHANNEL_ID,
    accountId: params.account.accountId,
    identity: fluxerIngressIdentity,
    cfg,
    useDefaultPairingStore: true,
  });

  if (isDirect) {
    const resolved = await resolver.message({
      subject: { stableId: authorId },
      conversation: {
        kind: "direct",
        id: message.channel_id || authorId,
      },
      dmPolicy: params.account.dmPolicy,
      groupPolicy: "disabled",
      allowFrom: params.account.allowFrom,
      command,
    });
    return {
      shouldDispatch: resolved.ingress.admission === "dispatch",
      commandAuthorized: resolved.commandAccess.requested
        ? resolved.commandAccess.authorized
        : resolved.senderAccess.allowed,
      hasAbortRequest,
      hasControlCommand: shouldCheckCommand,
      ingressAdmission: resolved.ingress.admission,
      isDirect: true,
    };
  }

  const channelId = message.channel_id;
  const groupConfig = resolveFluxerGroupConfig({
    account: params.account,
    channelId,
  });
  const routeAllowed = isFluxerGroupRouteAllowed({
    account: params.account,
    channelId,
    groupExplicitlyConfigured: groupConfig.explicit,
  });
  const senderAllowFrom = groupConfig.entry?.allowFrom ?? [];
  const wasMentioned = messageMentionsFluxerUser(message, params.botUserId);
  const requireMention = resolveFluxerGroupRequireMention({
    account: params.account,
    channelId,
  });
  const resolved = await resolver.message({
    subject: { stableId: authorId },
    conversation: {
      kind: "group",
      id: channelId,
    },
    event: {
      mayPair: false,
    },
    dmPolicy: "disabled",
    groupPolicy: senderAllowFrom.length > 0 ? "allowlist" : "open",
    groupAllowFrom: senderAllowFrom,
    mentionFacts: {
      canDetectMention: true,
      wasMentioned,
    },
    policy: {
      activation: {
        requireMention,
        allowTextCommands: true,
      },
    },
    route: {
      id: `channel:${channelId}`,
      allowed: routeAllowed,
      enabled: groupConfig.entry?.enabled !== false,
      blockReason:
        params.account.groupPolicy === "disabled"
          ? "Fluxer group policy is disabled."
          : "Fluxer channel is not allowlisted.",
    },
    command,
  });

  return {
    shouldDispatch: resolved.ingress.admission === "dispatch",
    commandAuthorized: resolved.commandAccess.requested
      ? resolved.commandAccess.authorized
      : resolved.senderAccess.allowed,
    hasAbortRequest,
    hasControlCommand: shouldCheckCommand,
    ingressAdmission: resolved.ingress.admission,
    wasMentioned,
    isDirect: false,
  };
}
