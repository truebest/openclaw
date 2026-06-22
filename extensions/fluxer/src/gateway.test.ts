// Fluxer tests cover gateway opcode handling and dispatch filtering helpers.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachFluxerGatewaySocket,
  normalizeFluxerGatewayUrl,
  shouldIgnoreFluxerGatewayMessage,
} from "./gateway.js";

class FakeSocket extends EventEmitter {
  sent: unknown[] = [];

  send = vi.fn((data: string) => {
    this.sent.push(JSON.parse(data));
  });

  close = vi.fn(() => {
    this.emit("close");
  });
}

describe("Fluxer gateway socket", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("identifies after HELLO, heartbeats, and records READY state", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const ready = vi.fn();
    const attachment = attachFluxerGatewaySocket({
      socket,
      token: "bot-token",
      onReady: ready,
    });

    socket.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 50 } }));
    expect(socket.sent[0]).toMatchObject({
      op: 2,
      d: {
        token: "Bot bot-token",
        properties: { browser: "openclaw", device: "openclaw" },
        intents: 4609,
        presence: { status: "online", afk: false },
      },
    });

    socket.emit(
      "message",
      JSON.stringify({
        op: 0,
        t: "READY",
        s: 42,
        d: { session_id: "sess-1", user: { id: "bot-1" } },
      }),
    );

    expect(ready).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", botUserId: "bot-1", lastSequence: 42 }),
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(socket.sent[1]).toEqual({ op: 1, d: 42 });
    attachment.dispose();
  });

  it("resumes when a previous session and sequence are known", () => {
    const socket = new FakeSocket();
    attachFluxerGatewaySocket({
      socket,
      token: "bot-token",
      state: { sessionId: "sess-1", lastSequence: 12 },
    });

    socket.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));

    expect(socket.sent[0]).toEqual({
      op: 6,
      d: { token: "Bot bot-token", session_id: "sess-1", seq: 12 },
    });
  });

  it("keeps an existing Bot token prefix for gateway authentication", () => {
    const socket = new FakeSocket();
    attachFluxerGatewaySocket({ socket, token: "Bot already-prefixed" });

    socket.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));

    expect(socket.sent[0]).toMatchObject({ op: 2, d: { token: "Bot already-prefixed" } });
  });

  it("supports string opcode gateways", () => {
    const socket = new FakeSocket();
    attachFluxerGatewaySocket({ socket, token: "bot-token" });

    socket.emit("message", JSON.stringify({ op: "HELLO", d: { heartbeat_interval: 1000 } }));

    expect(socket.sent[0]).toMatchObject({ op: "IDENTIFY", d: { token: "Bot bot-token" } });
  });

  it("adds Fluxer gateway query defaults when the API returns a bare websocket URL", () => {
    expect(normalizeFluxerGatewayUrl("ws://fluxer.local/gateway")).toBe(
      "ws://fluxer.local/gateway?v=1&encoding=json",
    );
    expect(normalizeFluxerGatewayUrl("wss://fluxer.local/gateway?v=1&encoding=json")).toBe(
      "wss://fluxer.local/gateway?v=1&encoding=json",
    );
  });

  it("dispatches MESSAGE_CREATE payloads", async () => {
    const socket = new FakeSocket();
    const onMessageCreate = vi.fn();
    attachFluxerGatewaySocket({
      socket,
      token: "bot-token",
      onMessageCreate,
    });

    socket.emit(
      "message",
      JSON.stringify({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 2,
        d: { id: "msg-1", channel_id: "chan-1", content: "hello" },
      }),
    );

    await vi.waitFor(() => expect(onMessageCreate).toHaveBeenCalledTimes(1));
    expect(onMessageCreate.mock.calls[0]?.[0]).toMatchObject({
      id: "msg-1",
      channel_id: "chan-1",
      content: "hello",
    });
    expect(onMessageCreate.mock.calls[0]?.[1]).toMatchObject({ lastSequence: 2 });
  });

  it("filters self messages and empty messages before inbound handling", () => {
    expect(
      shouldIgnoreFluxerGatewayMessage({
        message: {
          id: "msg-1",
          channel_id: "chan-1",
          content: "from self",
          author: { id: "bot-1" },
        },
        botUserId: "bot-1",
      }),
    ).toBe(true);
    expect(
      shouldIgnoreFluxerGatewayMessage({
        message: { id: "msg-2", channel_id: "chan-1", content: "   ", author_id: "user-1" },
        botUserId: "bot-1",
      }),
    ).toBe(true);
  });
});
