/**
 * Fluxer message helpers shared by gateway, access, and inbound dispatch.
 */
import type { FluxerMessage, FluxerUser } from "./types.js";

const DIRECT_CHANNEL_TYPES = new Set(["dm", "direct", "private", "group_dm"]);
const GROUP_CHANNEL_TYPES = new Set([
  "text",
  "channel",
  "group",
  "guild_text",
  "community",
  "community_text",
]);

export function fluxerMessageAuthorId(message: FluxerMessage): string {
  return message.author?.id ?? message.author_id ?? "";
}

export function fluxerMessageContent(message: FluxerMessage): string {
  return message.content ?? "";
}

export function fluxerMessageSenderName(message: FluxerMessage): string {
  const author = message.author;
  return (
    author?.display_name?.trim() ||
    author?.global_name?.trim() ||
    author?.username?.trim() ||
    author?.name?.trim() ||
    fluxerMessageAuthorId(message)
  );
}

function normalizeChannelType(value: string | number | null | undefined): string {
  return typeof value === "number" ? String(value) : (value?.trim().toLowerCase() ?? "");
}

export function isFluxerDirectMessage(message: FluxerMessage): boolean {
  if (message.direct === true || message.dm === true) {
    return true;
  }
  const channelType = normalizeChannelType(message.channel_type ?? message.channel?.type);
  if (DIRECT_CHANNEL_TYPES.has(channelType)) {
    return true;
  }
  if (GROUP_CHANNEL_TYPES.has(channelType)) {
    return false;
  }
  if (
    message.guild_id ||
    message.community_id ||
    message.group_id ||
    message.server_id ||
    message.channel?.guild_id ||
    message.channel?.community_id ||
    message.channel?.group_id ||
    message.channel?.server_id
  ) {
    return false;
  }
  // Unknown Fluxer channel shapes are treated as group-like so the default
  // route remains closed and mention-gated rather than accidentally opening DMs.
  return false;
}

function mentionId(mention: string | FluxerUser | { id?: string | null }): string {
  return typeof mention === "string" ? mention : (mention.id ?? "");
}

export function fluxerMessageMentionedUserIds(message: FluxerMessage): string[] {
  const ids = new Set<string>();
  for (const mention of message.mentions ?? []) {
    const id = mentionId(mention).trim();
    if (id) {
      ids.add(id);
    }
  }
  const content = fluxerMessageContent(message);
  for (const match of content.matchAll(/<@!?([^>\s]+)>/g)) {
    const id = match[1]?.trim();
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
}

export function messageMentionsFluxerUser(message: FluxerMessage, userId?: string | null): boolean {
  const target = userId?.trim();
  if (!target) {
    return false;
  }
  return fluxerMessageMentionedUserIds(message).includes(target);
}
