// Fluxer tests cover REST client URL normalization, auth, and bounded errors.
import { describe, expect, it, vi } from "vitest";
import { createFluxerClient, normalizeFluxerApiBaseUrl } from "./http-client.js";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function streamedErrorResponse(body: string, limit: number) {
  const encoded = new TextEncoder().encode(body);
  let readCount = 0;
  const cancel = vi.fn(async () => undefined);
  const releaseLock = vi.fn();
  const text = vi.fn(async () => {
    throw new Error("raw response.text() should not be used");
  });

  const response = {
    ok: false,
    status: 502,
    text,
    body: {
      getReader: () => ({
        read: async () => {
          if (readCount > 0) {
            return { done: true, value: undefined };
          }
          readCount += 1;
          return { done: false, value: encoded };
        },
        cancel,
        releaseLock,
      }),
    },
  } as unknown as Response;

  return {
    response,
    cancel,
    releaseLock,
    text,
    expectedDetail: body.slice(0, limit),
  };
}

describe("Fluxer HTTP client", () => {
  it("normalizes baseUrl to /api/v1", () => {
    expect(normalizeFluxerApiBaseUrl({ baseUrl: "http://fluxer.local/" })).toBe(
      "http://fluxer.local/api/v1",
    );
    expect(
      normalizeFluxerApiBaseUrl({
        baseUrl: "http://fluxer.local",
        apiBaseUrl: "http://fluxer.local/custom/",
      }),
    ).toBe("http://fluxer.local/custom");
  });

  it("sends Bot auth headers and Fluxer message payloads", async () => {
    const fetchMock = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      jsonResponse({ id: "msg-1", channel_id: "chan-1", content: "hello" }),
    );
    const client = createFluxerClient({
      baseUrl: "http://fluxer.local",
      token: "test-token",
      fetch: fetchMock,
    });

    await client.createChannelMessage("chan-1", {
      content: "hello",
      message_reference: { message_id: "root-1", channel_id: "chan-1" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://fluxer.local/api/v1/channels/chan-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: "hello",
          message_reference: { message_id: "root-1", channel_id: "chan-1" },
        }),
      }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bot test-token");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("bounds error response bodies without using raw response.text()", async () => {
    const streamed = streamedErrorResponse("x".repeat(9000), 8 * 1024);
    const fetchMock = vi.fn(async () => streamed.response);
    const client = createFluxerClient({
      baseUrl: "http://fluxer.local",
      token: "test-token",
      fetch: fetchMock,
    });

    await expect(client.gatewayBot()).rejects.toThrow(`Fluxer 502: ${streamed.expectedDetail}`);

    expect(streamed.text).not.toHaveBeenCalled();
    expect(streamed.cancel).toHaveBeenCalledTimes(1);
    expect(streamed.releaseLock).toHaveBeenCalledTimes(1);
  });
});
