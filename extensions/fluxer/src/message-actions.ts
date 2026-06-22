/**
 * Fluxer shared message-tool action surface.
 *
 * Fluxer send delivery is handled by the core durable outbound path; this
 * adapter only advertises send support and normalizes tool-send extraction.
 */
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { extractToolSend, type ChannelToolSend } from "openclaw/plugin-sdk/tool-send";
import { listEnabledFluxerAccounts, resolveFluxerAccount } from "./accounts.js";
import { normalizeFluxerTarget } from "./target.js";
import type { CoreConfig } from "./types.js";

function hasConfiguredAccount(cfg: CoreConfig, accountId?: string | null): boolean {
  if (accountId) {
    const account = resolveFluxerAccount({ cfg, accountId });
    return account.enabled && account.configured;
  }
  return listEnabledFluxerAccounts(cfg).some((account) => account.configured);
}

function resolveRawSendTarget(args: Record<string, unknown>): string | undefined {
  const explicitTarget =
    normalizeOptionalString(args.to) ??
    normalizeOptionalString(args.target) ??
    normalizeOptionalString(args.channelId);
  if (explicitTarget) {
    return explicitTarget;
  }
  const dmUserId = normalizeOptionalString(args.dmUserId);
  return dmUserId ? `dm:${dmUserId}` : undefined;
}

function normalizeToolSend(send: ChannelToolSend | null): ChannelToolSend | null {
  if (!send) {
    return null;
  }
  return {
    ...send,
    to: normalizeFluxerTarget(send.to),
  };
}

function extractFluxerSend(args: Record<string, unknown>, action: "send" | "sendMessage") {
  const rawTarget = resolveRawSendTarget(args);
  if (!rawTarget) {
    return null;
  }
  return normalizeToolSend(extractToolSend({ ...args, to: rawTarget }, action));
}

export const fluxerMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    if (!hasConfiguredAccount(cfg as CoreConfig, accountId)) {
      return null;
    }
    return { actions: ["send"] };
  },
  extractToolSend: ({ args }) =>
    extractFluxerSend(args, "send") ?? extractFluxerSend(args, "sendMessage"),
};
