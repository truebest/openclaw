/**
 * Fluxer group/channel policy helpers for mention requirements and tool policy.
 */
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import {
  resolveToolsBySender,
  type GroupToolPolicyConfig,
} from "openclaw/plugin-sdk/channel-policy";
import { resolveFluxerAccount, resolveDefaultFluxerAccountId } from "./accounts.js";
import type { CoreConfig, FluxerGroupConfig, ResolvedFluxerAccount } from "./types.js";

function stripFluxerChannelPrefix(value: string): string {
  return value
    .trim()
    .replace(/^fluxer:/i, "")
    .replace(/^channel:/i, "")
    .trim();
}

export function resolveFluxerGroupConfig(params: {
  account: Pick<ResolvedFluxerAccount, "groups">;
  channelId?: string | null;
}): { entry?: FluxerGroupConfig; explicit: boolean } {
  const groups = params.account.groups ?? {};
  const channelId = params.channelId?.trim();
  if (!channelId) {
    return { entry: groups["*"], explicit: false };
  }
  const candidates = [channelId, `channel:${channelId}`, `fluxer:channel:${channelId}`];
  for (const candidate of candidates) {
    if (Object.hasOwn(groups, candidate)) {
      return { entry: groups[candidate], explicit: candidate !== "*" };
    }
  }
  const matchedKey = Object.keys(groups).find(
    (key) => key !== "*" && stripFluxerChannelPrefix(key) === channelId,
  );
  if (matchedKey) {
    return { entry: groups[matchedKey], explicit: true };
  }
  return { entry: groups["*"], explicit: false };
}

function normalizedChannelAllowEntry(value: string): string {
  return stripFluxerChannelPrefix(value);
}

export function isFluxerGroupRouteAllowed(params: {
  account: ResolvedFluxerAccount;
  channelId: string;
  groupExplicitlyConfigured?: boolean;
}): boolean {
  if (params.account.groupPolicy === "disabled") {
    return false;
  }
  if (params.account.groupPolicy === "open") {
    return true;
  }
  const normalizedChannelId = normalizedChannelAllowEntry(params.channelId);
  if (params.groupExplicitlyConfigured) {
    return true;
  }
  return params.account.groupAllowFrom.some((entry) => {
    const normalized = normalizedChannelAllowEntry(entry);
    return normalized === "*" || normalized === normalizedChannelId;
  });
}

export function resolveFluxerGroupRequireMention(params: {
  account: ResolvedFluxerAccount;
  channelId?: string | null;
}): boolean {
  const resolved = resolveFluxerGroupConfig({
    account: params.account,
    channelId: params.channelId,
  });
  if (typeof resolved.entry?.requireMention === "boolean") {
    return resolved.entry.requireMention;
  }
  return params.account.requireMention;
}

function resolveGroupEntryFromContext(params: ChannelGroupContext): FluxerGroupConfig | undefined {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultFluxerAccountId(params.cfg as CoreConfig),
  );
  const account = resolveFluxerAccount({ cfg: params.cfg as CoreConfig, accountId });
  return resolveFluxerGroupConfig({
    account,
    channelId: params.groupId ?? params.groupChannel,
  }).entry;
}

export function resolveFluxerGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const entry = resolveGroupEntryFromContext(params);
  if (!entry) {
    return undefined;
  }
  const senderPolicy = resolveToolsBySender({
    toolsBySender: entry.toolsBySender,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  return senderPolicy ?? entry.tools;
}
