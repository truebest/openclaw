/**
 * Fluxer Gateway loop for opening the realtime websocket, heartbeating,
 * identifying/resuming, and dispatching user messages into OpenClaw.
 */
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { RawData } from "ws";
import { resolveFluxerAccount } from "./accounts.js";
import { createFluxerClient } from "./http-client.js";
import { handleFluxerInbound } from "./inbound.js";
import { fluxerMessageAuthorId, fluxerMessageContent } from "./message.js";
import type {
  CoreConfig,
  FluxerGatewayPayload,
  FluxerMessage,
  ResolvedFluxerAccount,
} from "./types.js";

type GatewayOpcodeName =
  | "DISPATCH"
  | "HEARTBEAT"
  | "IDENTIFY"
  | "RESUME"
  | "RECONNECT"
  | "INVALID_SESSION"
  | "HELLO"
  | "HEARTBEAT_ACK"
  | "UNKNOWN";

type GatewayOpcodeMode = "number" | "string";

type FluxerGatewaySocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): FluxerGatewaySocket;
};

export type FluxerGatewayState = {
  sessionId?: string;
  lastSequence?: number;
  botUserId?: string;
  resumeGatewayUrl?: string;
};

type GatewaySocketAttachment = {
  dispose: () => void;
  getState: () => FluxerGatewayState;
};

const FLUXER_GATEWAY_VERSION = "1";
const FLUXER_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12);

const NUMERIC_OPCODES: Record<Exclude<GatewayOpcodeName, "UNKNOWN">, number> = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

function decodeSocketMessage(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return Buffer.concat(data).toString("utf8");
}

export function decodeFluxerGatewayPayload(data: RawData | string): FluxerGatewayPayload | null {
  try {
    return JSON.parse(
      typeof data === "string" ? data : decodeSocketMessage(data),
    ) as FluxerGatewayPayload;
  } catch {
    return null;
  }
}

function opcodeName(op: FluxerGatewayPayload["op"]): GatewayOpcodeName {
  if (typeof op === "string") {
    const upper = op.trim().toUpperCase();
    return upper in NUMERIC_OPCODES ? (upper as GatewayOpcodeName) : "UNKNOWN";
  }
  switch (op) {
    case 0:
      return "DISPATCH";
    case 1:
      return "HEARTBEAT";
    case 7:
      return "RECONNECT";
    case 9:
      return "INVALID_SESSION";
    case 10:
      return "HELLO";
    case 11:
      return "HEARTBEAT_ACK";
    default:
      return "UNKNOWN";
  }
}

function encodeOpcode(
  name: Exclude<GatewayOpcodeName, "DISPATCH" | "UNKNOWN">,
  mode: GatewayOpcodeMode,
) {
  return mode === "string" ? name : NUMERIC_OPCODES[name];
}

function sequenceNumber(payload: FluxerGatewayPayload): number | undefined {
  const raw = payload.s ?? payload.seq;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function eventName(payload: FluxerGatewayPayload): string {
  return (payload.t ?? payload.type ?? "").trim().toUpperCase();
}

function dataObject(payload: FluxerGatewayPayload): Record<string, unknown> {
  return payload.d && typeof payload.d === "object" && !Array.isArray(payload.d)
    ? (payload.d as Record<string, unknown>)
    : {};
}

function heartbeatIntervalMs(payload: FluxerGatewayPayload): number {
  const data = dataObject(payload);
  const raw = data.heartbeat_interval ?? data.heartbeatInterval;
  return typeof raw === "number" && raw > 0 ? raw : 45_000;
}

function readyUserId(data: Record<string, unknown>): string | undefined {
  const user = data.user && typeof data.user === "object" ? (data.user as { id?: unknown }) : null;
  const bot = data.bot && typeof data.bot === "object" ? (data.bot as { id?: unknown }) : null;
  const direct = data.bot_user_id ?? data.botUserId;
  return typeof user?.id === "string"
    ? user.id
    : typeof bot?.id === "string"
      ? bot.id
      : typeof direct === "string"
        ? direct
        : undefined;
}

function readySessionId(data: Record<string, unknown>): string | undefined {
  const value = data.session_id ?? data.sessionId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readyResumeGatewayUrl(data: Record<string, unknown>): string | undefined {
  const value = data.resume_gateway_url ?? data.resumeGatewayUrl;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sendGatewayFrame(params: {
  socket: FluxerGatewaySocket;
  op: Exclude<GatewayOpcodeName, "DISPATCH" | "UNKNOWN">;
  mode: GatewayOpcodeMode;
  d: unknown;
}) {
  params.socket.send(
    JSON.stringify({
      op: encodeOpcode(params.op, params.mode),
      d: params.d,
    }),
  );
}

function botGatewayToken(token: string): string {
  return token.trim().startsWith("Bot ") ? token.trim() : `Bot ${token.trim()}`;
}

function identifyPayload(token: string) {
  return {
    token: botGatewayToken(token),
    properties: {
      os: process.platform,
      browser: "openclaw",
      device: "openclaw",
    },
    intents: FLUXER_GATEWAY_INTENTS,
    presence: {
      status: "online",
      afk: false,
    },
  };
}

export function normalizeFluxerGatewayUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!url.searchParams.has("v")) {
      url.searchParams.set("v", FLUXER_GATEWAY_VERSION);
    }
    if (!url.searchParams.has("encoding")) {
      url.searchParams.set("encoding", "json");
    }
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * Attaches Fluxer Gateway protocol handling to an already-created websocket.
 * This is exported so tests can verify HELLO/heartbeat/READY dispatch without
 * opening a network socket.
 */
export function attachFluxerGatewaySocket(params: {
  socket: FluxerGatewaySocket;
  token: string;
  state?: FluxerGatewayState;
  log?: Pick<Console, "warn">;
  onReady?: (state: FluxerGatewayState) => void;
  onMessageCreate?: (message: FluxerMessage, state: FluxerGatewayState) => void | Promise<void>;
  onReconnectRequested?: () => void;
}): GatewaySocketAttachment {
  const state: FluxerGatewayState = { ...(params.state ?? {}) };
  let opcodeMode: GatewayOpcodeMode = "number";
  let heartbeatTimer: NodeJS.Timeout | undefined;

  const clearHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };
  const heartbeat = () => {
    sendGatewayFrame({
      socket: params.socket,
      op: "HEARTBEAT",
      mode: opcodeMode,
      d: state.lastSequence ?? null,
    });
  };
  const startHeartbeat = (intervalMs: number) => {
    clearHeartbeat();
    heartbeatTimer = setInterval(heartbeat, intervalMs);
  };
  const identifyOrResume = () => {
    if (state.sessionId && state.lastSequence != null) {
      sendGatewayFrame({
        socket: params.socket,
        op: "RESUME",
        mode: opcodeMode,
        d: {
          token: botGatewayToken(params.token),
          session_id: state.sessionId,
          seq: state.lastSequence,
        },
      });
      return;
    }
    sendGatewayFrame({
      socket: params.socket,
      op: "IDENTIFY",
      mode: opcodeMode,
      d: identifyPayload(params.token),
    });
  };

  params.socket.on("message", (raw) => {
    void (async () => {
      const payload = decodeFluxerGatewayPayload(raw as RawData);
      if (!payload) {
        params.log?.warn?.("skipped malformed Fluxer gateway payload");
        return;
      }
      if (typeof payload.op === "string") {
        opcodeMode = "string";
      }
      const seq = sequenceNumber(payload);
      if (seq != null) {
        state.lastSequence = seq;
      }
      const op = opcodeName(payload.op);
      if (op === "HELLO") {
        startHeartbeat(heartbeatIntervalMs(payload));
        identifyOrResume();
        return;
      }
      if (op === "HEARTBEAT") {
        heartbeat();
        return;
      }
      if (op === "RECONNECT") {
        params.onReconnectRequested?.();
        params.socket.close();
        return;
      }
      if (op === "INVALID_SESSION") {
        state.sessionId = undefined;
        state.lastSequence = undefined;
        return;
      }
      if (op !== "DISPATCH") {
        return;
      }
      const name = eventName(payload);
      const payloadData = dataObject(payload);
      if (name === "READY") {
        state.sessionId = readySessionId(payloadData) ?? state.sessionId;
        state.botUserId = readyUserId(payloadData) ?? state.botUserId;
        state.resumeGatewayUrl = readyResumeGatewayUrl(payloadData) ?? state.resumeGatewayUrl;
        params.onReady?.({ ...state });
        return;
      }
      if (name === "MESSAGE_CREATE") {
        await params.onMessageCreate?.(payload.d as FluxerMessage, { ...state });
      }
    })().catch((error) => {
      params.log?.warn?.(
        `Fluxer gateway payload handler failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  });
  params.socket.on("close", clearHeartbeat);
  params.socket.on("error", clearHeartbeat);

  return {
    dispose: clearHeartbeat,
    getState: () => ({ ...state }),
  };
}

export function shouldIgnoreFluxerGatewayMessage(params: {
  message: FluxerMessage;
  botUserId?: string | null;
}): boolean {
  const botUserId = params.botUserId ?? "";
  if (!fluxerMessageContent(params.message).trim()) {
    return true;
  }
  return Boolean(botUserId && fluxerMessageAuthorId(params.message) === botUserId);
}

async function processGatewayMessage(params: {
  account: ResolvedFluxerAccount;
  config: CoreConfig;
  message: FluxerMessage;
  botUserId?: string | null;
}) {
  const botUserId = params.botUserId ?? params.account.botUserId ?? "";
  if (shouldIgnoreFluxerGatewayMessage({ message: params.message, botUserId })) {
    return;
  }
  await handleFluxerInbound({
    account: params.account,
    config: params.config,
    message: params.message,
    botUserId,
  });
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starts one Fluxer Gateway account until the OpenClaw gateway aborts it.
 */
export async function startFluxerGatewayAccount(ctx: ChannelGatewayContext<ResolvedFluxerAccount>) {
  const configuredAccount = resolveFluxerAccount({
    cfg: ctx.cfg,
    accountId: ctx.account.accountId,
  });
  if (!configuredAccount.configured) {
    throw new Error(`Fluxer is not configured for account "${configuredAccount.accountId}"`);
  }
  const client = createFluxerClient({
    baseUrl: configuredAccount.baseUrl,
    apiBaseUrl: configuredAccount.apiBaseUrl,
    token: configuredAccount.token,
  });
  const state: FluxerGatewayState = {
    botUserId: configuredAccount.botUserId,
  };
  ctx.setStatus({
    accountId: configuredAccount.accountId,
    running: true,
    configured: true,
    enabled: configuredAccount.enabled,
    baseUrl: configuredAccount.baseUrl,
  });
  try {
    while (!ctx.abortSignal.aborted) {
      const gateway = await client.gatewayBot();
      const gatewayUrl =
        configuredAccount.gatewayUrl ||
        state.resumeGatewayUrl ||
        gateway.url ||
        gateway.gateway_url;
      if (!gatewayUrl) {
        throw new Error("Fluxer gateway URL missing from GET /gateway/bot");
      }
      const socket = client.websocket(normalizeFluxerGatewayUrl(gatewayUrl));
      await new Promise<void>((resolve) => {
        let settled = false;
        let removeAbortListener: (() => void) | undefined;
        const finishSocketCycle = () => {
          if (settled) {
            return;
          }
          settled = true;
          removeAbortListener?.();
          removeAbortListener = undefined;
          resolve();
        };
        const abort = () => {
          socket.close();
          finishSocketCycle();
        };
        ctx.abortSignal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => ctx.abortSignal.removeEventListener("abort", abort);
        const attachment = attachFluxerGatewaySocket({
          socket,
          token: configuredAccount.token,
          state,
          log: ctx.log,
          onReady: (next) => {
            Object.assign(state, next);
          },
          onMessageCreate: async (message, next) => {
            Object.assign(state, next);
            await processGatewayMessage({
              account: {
                ...configuredAccount,
                botUserId: state.botUserId ?? configuredAccount.botUserId,
              },
              config: ctx.cfg,
              message,
              botUserId: state.botUserId,
            });
          },
          onReconnectRequested: finishSocketCycle,
        });
        socket.on("close", () => {
          attachment.dispose();
          finishSocketCycle();
        });
        socket.on("error", (error) => {
          ctx.log?.warn?.(
            `[${configuredAccount.accountId}] Fluxer websocket error; reconnecting: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          attachment.dispose();
          finishSocketCycle();
        });
      });
      if (!ctx.abortSignal.aborted) {
        await wait(configuredAccount.reconnectMs);
      }
    }
  } finally {
    ctx.setStatus({ accountId: configuredAccount.accountId, running: false });
  }
}
