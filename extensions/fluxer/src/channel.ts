import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
/**
 * Fluxer channel plugin definition: target parsing, account config, status,
 * gateway startup, and outbound delivery wiring.
 */
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import {
  DEFAULT_ACCOUNT_ID,
  listFluxerAccountIds,
  resolveDefaultFluxerAccountId,
  resolveFluxerAccount,
} from "./accounts.js";
import { fluxerConfigSchema } from "./config-schema.js";
import { startFluxerGatewayAccount } from "./gateway.js";
import { resolveFluxerGroupRequireMention, resolveFluxerGroupToolPolicy } from "./group-policy.js";
import { FLUXER_MESSAGE_CONTENT_LIMIT } from "./limits.js";
import { sendFluxerText } from "./outbound.js";
import {
  buildFluxerTarget,
  looksLikeFluxerTarget,
  normalizeFluxerTarget,
  parseFluxerTarget,
} from "./target.js";
import type { CoreConfig, ResolvedFluxerAccount } from "./types.js";

const CHANNEL_ID = "fluxer" as const;
const meta = { ...getChatChannelMeta(CHANNEL_ID) };

const fluxerMessageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      replyTo: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async (ctx) => {
      const result = await sendFluxerText({
        cfg: ctx.cfg as CoreConfig,
        accountId: ctx.accountId,
        to: ctx.to,
        text: ctx.text,
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
      });
      const threadId = ctx.threadId == null ? undefined : String(ctx.threadId);
      const replyToId = ctx.replyToId ?? undefined;
      return {
        messageId: result.messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: result.messageIds.map((messageId) => ({ channel: CHANNEL_ID, messageId })),
          threadId,
          replyToId,
          kind: "text",
        }),
      };
    },
  },
});

/**
 * Channel plugin instance registered by the bundled Fluxer entry.
 */
export const fluxerPlugin: ChannelPlugin<ResolvedFluxerAccount> = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta,
    capabilities: {
      chatTypes: ["direct", "group"],
      blockStreaming: true,
    },
    reload: { configPrefixes: ["channels.fluxer"] },
    configSchema: fluxerConfigSchema,
    config: {
      listAccountIds: (cfg) => listFluxerAccountIds(cfg as CoreConfig),
      resolveAccount: (cfg, accountId) =>
        resolveFluxerAccount({ cfg: cfg as CoreConfig, accountId }),
      defaultAccountId: (cfg) => resolveDefaultFluxerAccountId(cfg as CoreConfig),
      isConfigured: (account) => account.configured,
      resolveAllowFrom: ({ cfg, accountId }) =>
        resolveFluxerAccount({ cfg: cfg as CoreConfig, accountId }).allowFrom,
      resolveDefaultTo: ({ cfg, accountId }) =>
        resolveFluxerAccount({ cfg: cfg as CoreConfig, accountId }).defaultTo,
    },
    groups: {
      resolveRequireMention: ({ cfg, accountId, groupId, groupChannel }) =>
        resolveFluxerGroupRequireMention({
          account: resolveFluxerAccount({ cfg: cfg as CoreConfig, accountId }),
          channelId: groupId ?? groupChannel,
        }),
      resolveToolPolicy: resolveFluxerGroupToolPolicy,
    },
    messaging: {
      targetPrefixes: ["fluxer", "fx"],
      normalizeTarget: normalizeFluxerTarget,
      inferTargetChatType: ({ to }) => parseFluxerTarget(to).chatType,
      targetResolver: {
        looksLikeId: looksLikeFluxerTarget,
        hint: "<channel:id|dm:user_id>",
      },
      resolveOutboundSessionRoute: ({
        cfg,
        agentId,
        accountId,
        target,
        replyToId,
        threadId,
        currentSessionKey,
      }) => {
        const parsed = parseFluxerTarget(target);
        const baseRoute = buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: CHANNEL_ID,
          accountId,
          peer: {
            kind: parsed.chatType === "direct" ? "direct" : "channel",
            id: buildFluxerTarget(parsed),
          },
          chatType: parsed.chatType,
          from: `fluxer:${accountId ?? DEFAULT_ACCOUNT_ID}`,
          to: buildFluxerTarget(parsed),
        });
        return buildThreadAwareOutboundSessionRoute({
          route: baseRoute,
          replyToId,
          threadId,
          currentSessionKey,
          canRecoverCurrentThread: () => true,
        });
      },
      resolveSessionConversation: ({ rawId }) => {
        const parsed = parseFluxerTarget(rawId);
        if (parsed.kind === "dm") {
          return null;
        }
        return {
          id: parsed.id,
          baseConversationId: parsed.id,
          parentConversationCandidates: [parsed.id],
        };
      },
    },
    status: createComputedAccountStatusAdapter<ResolvedFluxerAccount>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      buildChannelSummary: ({ snapshot }) => ({
        ok: snapshot.configured,
        label: snapshot.configured ? "configured" : "missing config",
        detail: snapshot.baseUrl ?? "",
      }),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        baseUrl: account.baseUrl,
      }),
    }),
    gateway: {
      startAccount: startFluxerGatewayAccount,
    },
    message: fluxerMessageAdapter,
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      chunker: (text, limit) => chunkTextForOutbound(text, limit),
      textChunkLimit: FLUXER_MESSAGE_CONTENT_LIMIT,
    },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async ({ cfg, to, text, accountId, threadId, replyToId }) =>
        await sendFluxerText({
          cfg: cfg as CoreConfig,
          accountId,
          to,
          text,
          threadId,
          replyToId,
        }),
    },
  },
});
