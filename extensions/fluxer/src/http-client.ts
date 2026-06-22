/**
 * Thin Fluxer REST/websocket client used by gateway and outbound delivery code.
 */
import { readResponseTextLimited } from "openclaw/plugin-sdk/provider-http";
import { WebSocket } from "ws";
import type { FluxerChannel, FluxerGatewayBotResponse, FluxerMessage } from "./types.js";

type ClientOptions = {
  baseUrl: string;
  apiBaseUrl?: string;
  token: string;
  fetch?: typeof fetch;
};

const FLUXER_ERROR_BODY_LIMIT_BYTES = 8 * 1024;

function trimTrailingSlashes(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function normalizeFluxerApiBaseUrl(options: {
  baseUrl: string;
  apiBaseUrl?: string | null;
}): string {
  const explicit = options.apiBaseUrl?.trim();
  if (explicit) {
    return trimTrailingSlashes(explicit);
  }
  const baseUrl = trimTrailingSlashes(options.baseUrl);
  return baseUrl ? `${baseUrl}/api/v1` : "";
}

function normalizeFluxerMessageResponse(data: unknown): FluxerMessage {
  const wrapped = data as { message?: FluxerMessage };
  return wrapped.message ?? (data as FluxerMessage);
}

function normalizeFluxerChannelResponse(data: unknown): FluxerChannel {
  const wrapped = data as { channel?: FluxerChannel };
  return wrapped.channel ?? (data as FluxerChannel);
}

/**
 * Creates a typed client for the Fluxer API using Bot-token auth.
 */
export function createFluxerClient(options: ClientOptions) {
  const apiBaseUrl = normalizeFluxerApiBaseUrl({
    baseUrl: options.baseUrl,
    apiBaseUrl: options.apiBaseUrl,
  });
  const fetcher = options.fetch ?? fetch;
  const headers = {
    Authorization: `Bot ${options.token}`,
    Accept: "application/json",
  };

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const requestHeaders = new Headers(init.headers);
    for (const [key, value] of Object.entries(headers)) {
      requestHeaders.set(key, value);
    }
    if (init.body && !(init.body instanceof FormData)) {
      requestHeaders.set("Content-Type", "application/json");
    }
    const response = await fetcher(`${apiBaseUrl}${path}`, {
      ...init,
      headers: requestHeaders,
    });
    if (!response.ok) {
      const detail = await readResponseTextLimited(response, FLUXER_ERROR_BODY_LIMIT_BYTES);
      throw new Error(`Fluxer ${response.status}: ${detail}`);
    }
    return (await response.json()) as T;
  }

  return {
    gatewayBot: async (): Promise<FluxerGatewayBotResponse> =>
      await request<FluxerGatewayBotResponse>("/gateway/bot"),
    createChannelMessage: async (
      channelId: string,
      body: {
        content: string;
        message_reference?: { message_id: string; channel_id?: string };
      },
    ): Promise<FluxerMessage> =>
      normalizeFluxerMessageResponse(
        await request<FluxerMessage | { message: FluxerMessage }>(
          `/channels/${encodeURIComponent(channelId)}/messages`,
          { method: "POST", body: JSON.stringify(body) },
        ),
      ),
    createDirectChannel: async (recipientId: string): Promise<FluxerChannel> =>
      normalizeFluxerChannelResponse(
        await request<FluxerChannel | { channel: FluxerChannel }>("/users/@me/channels", {
          method: "POST",
          body: JSON.stringify({ recipient_id: recipientId }),
        }),
      ),
    websocket: (url: string): WebSocket =>
      new WebSocket(url, {
        headers: {
          Authorization: `Bot ${options.token}`,
        },
      }),
  };
}

/** Client shape returned by `createFluxerClient`. */
export type FluxerClient = ReturnType<typeof createFluxerClient>;
