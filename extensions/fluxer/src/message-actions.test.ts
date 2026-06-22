// Fluxer tests cover shared message-tool action discovery and send extraction.
import { describe, expect, it } from "vitest";
import { fluxerPlugin } from "./channel.js";
import { fluxerMessageActions } from "./message-actions.js";
import type { CoreConfig } from "./types.js";

function configuredFluxerConfig(): CoreConfig {
  return {
    channels: {
      fluxer: {
        baseUrl: "http://fluxer.local",
        token: "bot-token",
        accounts: {
          disabled: { enabled: false, token: "disabled-token" },
          missingToken: { token: "" },
          work: { token: "work-token" },
        },
      },
    },
  } satisfies CoreConfig;
}

describe("fluxerMessageActions", () => {
  it("advertises send only for configured accounts", () => {
    expect(fluxerMessageActions.describeMessageTool({ cfg: {} }) ?? null).toBeNull();

    const cfg = configuredFluxerConfig();
    expect(fluxerMessageActions.describeMessageTool({ cfg })?.actions).toEqual(["send"]);
    expect(fluxerMessageActions.describeMessageTool({ cfg, accountId: "work" })?.actions).toEqual([
      "send",
    ]);
    expect(
      fluxerMessageActions.describeMessageTool({ cfg, accountId: "disabled" }) ?? null,
    ).toBeNull();
    expect(
      fluxerMessageActions.describeMessageTool({ cfg, accountId: "missingToken" }) ?? null,
    ).toBeNull();
  });

  it("is wired into the Fluxer plugin action surface", () => {
    expect(
      fluxerPlugin.actions?.describeMessageTool({ cfg: configuredFluxerConfig() })?.actions,
    ).toEqual(["send"]);
    expect(fluxerPlugin.actions?.handleAction).toBeUndefined();
  });

  it("extracts and normalizes shared message sends", () => {
    expect(
      fluxerMessageActions.extractToolSend?.({
        args: { action: "send", to: "123456789", accountId: "work", threadId: 42 },
      }),
    ).toEqual({
      to: "channel:123456789",
      accountId: "work",
      threadId: "42",
    });

    expect(
      fluxerMessageActions.extractToolSend?.({
        args: { action: "send", target: "dm:987654321", topLevel: true },
      }),
    ).toEqual({
      to: "dm:987654321",
      threadSuppressed: true,
    });

    expect(
      fluxerMessageActions.extractToolSend?.({
        args: { action: "send", channelId: "123456789" },
      }),
    ).toEqual({
      to: "channel:123456789",
    });

    expect(
      fluxerMessageActions.extractToolSend?.({
        args: { action: "send", dmUserId: "987654321" },
      }),
    ).toEqual({
      to: "dm:987654321",
    });
  });

  it("extracts legacy sendMessage actions without claiming unsupported actions", () => {
    expect(
      fluxerMessageActions.extractToolSend?.({
        args: { action: "sendMessage", to: "channel:123456789" },
      }),
    ).toEqual({
      to: "channel:123456789",
    });

    expect(
      fluxerMessageActions.extractToolSend?.({
        args: { action: "react", to: "channel:123456789" },
      }),
    ).toBeNull();
  });
});
