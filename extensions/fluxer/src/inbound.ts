/**
 * Converts authorized Fluxer messages into OpenClaw agent replies and routes
 * resulting outbound text back to Fluxer.
 */
import {
  classifyChannelInboundEvent,
  resolveUnmentionedGroupInboundPolicy,
  type InboundEventKind,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveFluxerInboundAccess, type FluxerInboundAccess } from "./access.js";
import {
  fluxerMessageAuthorId,
  fluxerMessageContent,
  fluxerMessageSenderName,
  isFluxerDirectMessage,
} from "./message.js";
import { sendFluxerText } from "./outbound.js";
import { getFluxerRuntime } from "./runtime.js";
import type { CoreConfig, FluxerMessage, ResolvedFluxerAccount } from "./types.js";

const CHANNEL_ID = "fluxer" as const;

function resolveAccountAgentRoute(params: {
  cfg: OpenClawConfig;
  account: ResolvedFluxerAccount;
  target: string;
  isDirect: boolean;
}) {
  const runtime = getFluxerRuntime();
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer: {
      kind: params.isDirect ? "direct" : "channel",
      id: params.target,
    },
  });
  const agentId = params.account.agentId ?? route.agentId;
  if (agentId === route.agentId) {
    return route;
  }
  return {
    ...route,
    agentId,
    sessionKey: runtime.channel.routing.buildAgentSessionKey({
      agentId,
      channel: CHANNEL_ID,
      accountId: params.account.accountId,
      peer: {
        kind: params.isDirect ? "direct" : "channel",
        id: params.target,
      },
    }),
  };
}

function fluxerTargetForMessage(message: FluxerMessage): string {
  return isFluxerDirectMessage(message)
    ? `dm:${fluxerMessageAuthorId(message)}`
    : `channel:${message.channel_id}`;
}

function resolveFluxerInboundEventKind(params: {
  access: FluxerInboundAccess;
  cfg: OpenClawConfig;
  agentId: string;
}): InboundEventKind {
  if (params.access.isDirect) {
    return "user_request";
  }
  return classifyChannelInboundEvent({
    conversation: { kind: "group" },
    unmentionedGroupPolicy: resolveUnmentionedGroupInboundPolicy({
      cfg: params.cfg,
      agentId: params.agentId,
    }),
    wasMentioned: params.access.wasMentioned,
    hasControlCommand: params.access.hasControlCommand,
    hasAbortRequest: params.access.hasAbortRequest,
  });
}

function shouldDispatchFluxerInbound(params: {
  access: FluxerInboundAccess;
  inboundEventKind: InboundEventKind;
}): boolean {
  if (params.access.shouldDispatch) {
    return true;
  }
  return (
    !params.access.isDirect &&
    params.inboundEventKind === "room_event" &&
    params.access.ingressAdmission === "skip"
  );
}

/**
 * Dispatches one already-fetched Fluxer message through the configured account.
 */
export async function handleFluxerInbound(params: {
  account: ResolvedFluxerAccount;
  config: CoreConfig;
  message: FluxerMessage;
  botUserId?: string | null;
  access?: FluxerInboundAccess;
}) {
  const runtime = getFluxerRuntime();
  const message = params.message;
  const access =
    params.access ??
    (await resolveFluxerInboundAccess({
      account: params.account,
      config: params.config,
      message,
      botUserId: params.botUserId,
    }));
  const isDirect = access.isDirect;
  const target = fluxerTargetForMessage(message);
  const route = resolveAccountAgentRoute({
    cfg: params.config as OpenClawConfig,
    account: params.account,
    target,
    isDirect,
  });
  const inboundEventKind = resolveFluxerInboundEventKind({
    access,
    cfg: params.config as OpenClawConfig,
    agentId: route.agentId,
  });
  if (!shouldDispatchFluxerInbound({ access, inboundEventKind })) {
    return;
  }
  const senderName = fluxerMessageSenderName(message);
  const content = fluxerMessageContent(message);
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath: runtime.channel.session.resolveStorePath(params.config.session?.store, {
      agentId: route.agentId,
    }),
    sessionKey: route.sessionKey,
  });
  const timestamp = message.timestamp ?? message.created_at ?? new Date().toISOString();
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: "Fluxer",
    from: senderName,
    timestamp: new Date(timestamp),
    previousTimestamp,
    envelope: runtime.channel.reply.resolveEnvelopeFormatOptions(params.config as OpenClawConfig),
    body: content,
  });
  const storePath = runtime.channel.session.resolveStorePath(params.config.session?.store, {
    agentId: route.agentId,
  });
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: content,
    RawBody: content,
    CommandBody: content,
    From: target,
    To: target,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? params.account.accountId,
    ChatType: isDirect ? "direct" : "group",
    InboundEventKind: inboundEventKind,
    WasMentioned: isDirect ? undefined : Boolean(access.wasMentioned),
    ConversationLabel: isDirect ? senderName : message.channel_id,
    GroupChannel: isDirect ? undefined : message.channel_id,
    NativeChannelId: message.channel_id,
    SenderName: senderName,
    SenderId: fluxerMessageAuthorId(message),
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: message.id,
    MessageSidFull: message.id,
    ReplyToId: message.id,
    Timestamp: timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: target,
    CommandAuthorized: access.commandAuthorized,
  });
  await runtime.channel.inbound.dispatchReply({
    cfg: params.config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    agentId: route.agentId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: runtime.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    delivery: {
      deliver: async (payload) => {
        const text =
          payload && typeof payload === "object" && "text" in payload
            ? ((payload as { text?: string }).text ?? "")
            : "";
        if (!text.trim()) {
          return;
        }
        await sendFluxerText({
          cfg: params.config,
          accountId: params.account.accountId,
          to: target,
          text,
          replyToId: message.id,
        });
      },
      onError: (error) => {
        throw error instanceof Error
          ? error
          : new Error(`fluxer dispatch failed: ${String(error)}`);
      },
    },
    replyPipeline: {},
    record: {
      onRecordError: (error) => {
        throw error instanceof Error
          ? error
          : new Error(`fluxer session record failed: ${String(error)}`);
      },
    },
  });
}
