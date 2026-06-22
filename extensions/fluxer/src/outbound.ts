/**
 * Outbound Fluxer delivery helpers for channel messages and direct messages.
 */
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { resolveFluxerAccount } from "./accounts.js";
import { createFluxerClient } from "./http-client.js";
import { FLUXER_MESSAGE_CONTENT_LIMIT } from "./limits.js";
import { parseFluxerTarget } from "./target.js";
import type { CoreConfig, FluxerMessage } from "./types.js";

function buildMessageReference(params: {
  channelId?: string;
  replyToId?: string | number | null;
  threadId?: string | number | null;
}) {
  const messageId = params.replyToId ?? params.threadId;
  if (messageId == null) {
    return undefined;
  }
  const id = String(messageId).trim();
  if (!id) {
    return undefined;
  }
  return {
    message_id: id,
    ...(params.channelId ? { channel_id: params.channelId } : {}),
  };
}

async function sendChunks(params: {
  chunks: string[];
  channelId: string;
  replyChannelId?: string;
  replyToId?: string | number | null;
  threadId?: string | number | null;
  createChannelMessage: ReturnType<typeof createFluxerClient>["createChannelMessage"];
}): Promise<FluxerMessage[]> {
  const messages: FluxerMessage[] = [];
  for (const chunk of params.chunks) {
    const messageReference = buildMessageReference({
      channelId: params.replyChannelId ?? params.channelId,
      replyToId: params.replyToId,
      threadId: params.threadId,
    });
    const message = await params.createChannelMessage(params.channelId, {
      content: chunk,
      ...(messageReference ? { message_reference: messageReference } : {}),
    });
    messages.push(message);
  }
  return messages;
}

/**
 * Sends text to a normalized Fluxer target and returns created message ids for
 * receipt/session tracking.
 */
export async function sendFluxerText(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  to: string;
  text: string;
  threadId?: string | number | null;
  replyToId?: string | number | null;
}) {
  const account = resolveFluxerAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    throw new Error(`Fluxer is not configured for account "${account.accountId}"`);
  }
  const client = createFluxerClient({
    baseUrl: account.baseUrl,
    apiBaseUrl: account.apiBaseUrl,
    token: account.token,
  });
  const parsed = parseFluxerTarget(params.to);
  const chunks = chunkTextForOutbound(params.text, FLUXER_MESSAGE_CONTENT_LIMIT);
  if (chunks.length === 0) {
    return { to: params.to, messageId: "", messageIds: [] };
  }
  if (parsed.kind === "dm") {
    const dm = await client.createDirectChannel(parsed.id);
    const messages = await sendChunks({
      chunks,
      channelId: dm.id,
      replyToId: params.replyToId,
      threadId: params.threadId,
      createChannelMessage: client.createChannelMessage,
    });
    const last = messages.at(-1);
    return {
      to: params.to,
      messageId: last?.id ?? "",
      messageIds: messages.map((message) => message.id),
    };
  }
  const messages = await sendChunks({
    chunks,
    channelId: parsed.id,
    replyChannelId: parsed.id,
    replyToId: params.replyToId,
    threadId: params.threadId,
    createChannelMessage: client.createChannelMessage,
  });
  const last = messages.at(-1);
  return {
    to: params.to,
    messageId: last?.id ?? "",
    messageIds: messages.map((message) => message.id),
  };
}
