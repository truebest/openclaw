// Fluxer tests cover DM policy and group mention-gating decisions.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFluxerInboundAccess } from "./access.js";
import { setFluxerRuntime } from "./runtime.js";
import type { CoreConfig, FluxerMessage, ResolvedFluxerAccount } from "./types.js";

function createAccount(overrides: Partial<ResolvedFluxerAccount> = {}): ResolvedFluxerAccount {
  const base = {
    accountId: "default",
    enabled: true,
    configured: true,
    baseUrl: "http://fluxer.local",
    apiBaseUrl: "http://fluxer.local/api/v1",
    token: "token",
    defaultTo: "channel:123456789",
    dmPolicy: "pairing",
    allowFrom: [],
    groupPolicy: "allowlist",
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
    content: "hello",
    author: { id: "user-1", username: "peter" },
    mentions: [],
    ...overrides,
  };
}

describe("Fluxer inbound access", () => {
  beforeEach(() => {
    const runtime = createPluginRuntimeMock({
      channel: {
        commands: {
          shouldComputeCommandAuthorized: vi.fn(() => false),
        },
      },
    } as unknown as PluginRuntime);
    setFluxerRuntime(runtime);
  });

  it("admits open DMs only when allowFrom includes the sender or wildcard", async () => {
    const cfg = {} satisfies CoreConfig;
    const message = createMessage({
      guild_id: undefined,
      channel_type: "dm",
      author: { id: "user-1" },
    });

    await expect(
      resolveFluxerInboundAccess({
        account: createAccount({ dmPolicy: "open", allowFrom: [] }),
        config: cfg,
        message,
      }),
    ).resolves.toMatchObject({ shouldDispatch: false, isDirect: true });

    await expect(
      resolveFluxerInboundAccess({
        account: createAccount({ dmPolicy: "open", allowFrom: ["*"] }),
        config: cfg,
        message,
      }),
    ).resolves.toMatchObject({ shouldDispatch: true, isDirect: true });
  });

  it("requires bot mention in open group channels by default", async () => {
    const cfg = {} satisfies CoreConfig;
    const account = createAccount({ groupPolicy: "open", botUserId: "bot-1" });

    await expect(
      resolveFluxerInboundAccess({
        account,
        config: cfg,
        message: createMessage({ content: "hello", mentions: [] }),
        botUserId: "bot-1",
      }),
    ).resolves.toMatchObject({ shouldDispatch: false, wasMentioned: false, isDirect: false });

    await expect(
      resolveFluxerInboundAccess({
        account,
        config: cfg,
        message: createMessage({ content: "hey bot", mentions: [{ id: "bot-1" }] }),
        botUserId: "bot-1",
      }),
    ).resolves.toMatchObject({ shouldDispatch: true, wasMentioned: true, isDirect: false });
  });

  it("keeps default allowlist group policy closed until the channel is allowlisted", async () => {
    const cfg = {} satisfies CoreConfig;

    await expect(
      resolveFluxerInboundAccess({
        account: createAccount({
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        }),
        config: cfg,
        message: createMessage({ mentions: [{ id: "bot-1" }] }),
        botUserId: "bot-1",
      }),
    ).resolves.toMatchObject({ shouldDispatch: false });

    await expect(
      resolveFluxerInboundAccess({
        account: createAccount({
          groupPolicy: "allowlist",
          groupAllowFrom: ["channel:chan-1"],
        }),
        config: cfg,
        message: createMessage({ mentions: [{ id: "bot-1" }] }),
        botUserId: "bot-1",
      }),
    ).resolves.toMatchObject({ shouldDispatch: true });
  });
});
