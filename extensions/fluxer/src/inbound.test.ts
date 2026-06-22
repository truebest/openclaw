// Fluxer tests cover inbound context projection into the agent reply pipeline.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleFluxerInbound } from "./inbound.js";
import { setFluxerRuntime } from "./runtime.js";
import type { CoreConfig, FluxerMessage, ResolvedFluxerAccount } from "./types.js";

const sendFluxerTextMock = vi.hoisted(() => vi.fn());

vi.mock("./outbound.js", () => ({
  sendFluxerText: sendFluxerTextMock,
}));

function createRuntime(): PluginRuntime {
  return createPluginRuntimeMock({
    channel: {
      routing: {
        resolveAgentRoute({
          accountId,
          peer,
        }: Parameters<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>[0]) {
          return {
            agentId: "main",
            channel: "fluxer",
            accountId: accountId ?? "default",
            sessionKey: `agent:main:fluxer:${peer?.kind ?? "channel"}:${peer?.id ?? "unknown"}`,
            mainSessionKey: "agent:main:main",
            lastRoutePolicy: "session",
            matchedBy: "default",
          };
        },
        buildAgentSessionKey({
          agentId,
          channel,
          accountId,
          peer,
        }: Parameters<PluginRuntime["channel"]["routing"]["buildAgentSessionKey"]>[0]) {
          return `agent:${agentId}:${channel}:${accountId ?? "default"}:${peer?.kind ?? "channel"}:${peer?.id ?? "unknown"}`;
        },
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
      },
    },
  } as unknown as PluginRuntime);
}

function createAccount(overrides: Partial<ResolvedFluxerAccount> = {}): ResolvedFluxerAccount {
  const base = {
    accountId: "default",
    enabled: true,
    configured: true,
    baseUrl: "http://fluxer.local",
    apiBaseUrl: "http://fluxer.local/api/v1",
    token: "token",
    botUserId: "bot-1",
    dmPolicy: "pairing",
    allowFrom: [],
    groupPolicy: "open",
    groupAllowFrom: [],
    requireMention: true,
    groups: {},
    reconnectMs: 1_500,
    config: {
      allowFrom: [],
      groupAllowFrom: [],
      groups: {},
    },
  } satisfies ResolvedFluxerAccount;

  return {
    ...base,
    ...overrides,
    config: {
      ...base.config,
      ...overrides.config,
    },
  };
}

function createMessage(overrides: Partial<FluxerMessage> = {}): FluxerMessage {
  return {
    id: "msg-1",
    channel_id: "chan-1",
    guild_id: "guild-1",
    content: "hey <@bot-1>",
    author: { id: "user-1", username: "peter" },
    mentions: [{ id: "bot-1" }],
    timestamp: "2026-05-09T12:00:00.000Z",
    ...overrides,
  };
}

describe("handleFluxerInbound", () => {
  beforeEach(() => {
    sendFluxerTextMock.mockClear();
  });

  it("projects Fluxer group messages into OpenClaw inbound context", async () => {
    const runtime = createRuntime();
    setFluxerRuntime(runtime);
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4-mini",
        },
      },
    } satisfies CoreConfig;

    await handleFluxerInbound({
      account: createAccount(),
      config: cfg,
      message: createMessage(),
      botUserId: "bot-1",
    });

    const dispatchReply = vi.mocked(runtime.channel.inbound.dispatchReply);
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    expect(dispatchReply.mock.calls[0]?.[0].ctxPayload).toMatchObject({
      Provider: "fluxer",
      Surface: "fluxer",
      ChatType: "group",
      InboundEventKind: "user_request",
      WasMentioned: true,
      From: "channel:chan-1",
      To: "channel:chan-1",
      GroupChannel: "chan-1",
      SenderId: "user-1",
      ReplyToId: "msg-1",
      CommandAuthorized: true,
    });
  });

  it("does not dispatch group messages that miss mention gating", async () => {
    const runtime = createRuntime();
    setFluxerRuntime(runtime);

    await handleFluxerInbound({
      account: createAccount(),
      config: {} satisfies CoreConfig,
      message: createMessage({ content: "hello", mentions: [] }),
      botUserId: "bot-1",
    });

    expect(runtime.channel.inbound.dispatchReply).not.toHaveBeenCalled();
  });

  it("dispatches unmentioned group messages as room events when configured", async () => {
    const runtime = createRuntime();
    setFluxerRuntime(runtime);
    const cfg = {
      messages: {
        groupChat: {
          unmentionedInbound: "room_event",
        },
      },
    } satisfies CoreConfig;

    await handleFluxerInbound({
      account: createAccount(),
      config: cfg,
      message: createMessage({ content: "ambient chatter", mentions: [] }),
      botUserId: "bot-1",
    });

    const dispatchReply = vi.mocked(runtime.channel.inbound.dispatchReply);
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    expect(dispatchReply.mock.calls[0]?.[0].ctxPayload).toMatchObject({
      ChatType: "group",
      InboundEventKind: "room_event",
      WasMentioned: false,
      BodyForAgent: "ambient chatter",
      From: "channel:chan-1",
      To: "channel:chan-1",
    });
  });

  it("allows visible delivery when the current bot is explicitly mentioned", async () => {
    const runtime = createRuntime();
    setFluxerRuntime(runtime);

    await handleFluxerInbound({
      account: createAccount(),
      config: {} satisfies CoreConfig,
      message: createMessage({
        content: "<@bot-1> как дела?",
        mentions: [{ id: "bot-1" }],
      }),
      botUserId: "bot-1",
    });

    const dispatchReply = vi.mocked(runtime.channel.inbound.dispatchReply);
    await dispatchReply.mock.calls[0]?.[0].delivery.deliver(
      { text: "right bot reply" },
      { kind: "final" },
    );

    expect(sendFluxerTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "channel:chan-1",
        text: "right bot reply",
        replyToId: "msg-1",
      }),
    );
  });
});
