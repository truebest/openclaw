// Fluxer tests cover outbound channel/DM sending and text chunking.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FLUXER_MESSAGE_CONTENT_LIMIT } from "./limits.js";
import type { CoreConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  client: {
    createChannelMessage: vi.fn(),
    createDirectChannel: vi.fn(),
  },
  createFluxerClient: vi.fn(),
}));

vi.mock("./http-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./http-client.js")>();
  return {
    ...actual,
    createFluxerClient: mocks.createFluxerClient,
  };
});

const { sendFluxerText } = await import("./outbound.js");

function createConfig(): CoreConfig {
  return {
    channels: {
      fluxer: {
        baseUrl: "http://fluxer.local",
        token: "token",
      },
    },
  } satisfies CoreConfig;
}

describe("sendFluxerText", () => {
  beforeEach(() => {
    mocks.createFluxerClient.mockReset();
    mocks.client.createChannelMessage.mockReset();
    mocks.client.createDirectChannel.mockReset();
  });

  it("sends channel messages with message_reference reply context", async () => {
    mocks.createFluxerClient.mockReturnValue(mocks.client);
    mocks.client.createChannelMessage.mockResolvedValue({
      id: "msg-1",
      channel_id: "123456789",
      content: "hello",
    });

    await expect(
      sendFluxerText({
        cfg: createConfig(),
        to: "channel:123456789",
        text: "hello",
        replyToId: "root-1",
      }),
    ).resolves.toEqual({ to: "channel:123456789", messageId: "msg-1", messageIds: ["msg-1"] });

    expect(mocks.client.createChannelMessage).toHaveBeenCalledWith("123456789", {
      content: "hello",
      message_reference: { message_id: "root-1", channel_id: "123456789" },
    });
  });

  it("creates a DM channel before sending direct messages", async () => {
    mocks.createFluxerClient.mockReturnValue(mocks.client);
    mocks.client.createDirectChannel.mockResolvedValue({ id: "dm-channel-1" });
    mocks.client.createChannelMessage.mockResolvedValue({
      id: "msg-1",
      channel_id: "dm-channel-1",
      content: "hello",
    });

    await sendFluxerText({
      cfg: createConfig(),
      to: "dm:987654321",
      text: "hello",
    });

    expect(mocks.client.createDirectChannel).toHaveBeenCalledWith("987654321");
    expect(mocks.client.createChannelMessage).toHaveBeenCalledWith("dm-channel-1", {
      content: "hello",
    });
  });

  it("chunks long text to the Fluxer content limit", async () => {
    mocks.createFluxerClient.mockReturnValue(mocks.client);
    mocks.client.createChannelMessage
      .mockResolvedValueOnce({ id: "msg-1", channel_id: "123456789", content: "a" })
      .mockResolvedValueOnce({ id: "msg-2", channel_id: "123456789", content: "b" });
    const text = `${"x".repeat(FLUXER_MESSAGE_CONTENT_LIMIT)}y`;

    await expect(
      sendFluxerText({
        cfg: createConfig(),
        to: "123456789",
        text,
      }),
    ).resolves.toEqual({
      to: "123456789",
      messageId: "msg-2",
      messageIds: ["msg-1", "msg-2"],
    });

    expect(mocks.client.createChannelMessage).toHaveBeenCalledTimes(2);
    for (const call of mocks.client.createChannelMessage.mock.calls) {
      expect((call[1] as { content: string }).content.length).toBeLessThanOrEqual(
        FLUXER_MESSAGE_CONTENT_LIMIT,
      );
    }
  });
});
