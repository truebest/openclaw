// Fluxer tests cover account config merging and env SecretRef defaults.
import { describe, expect, it } from "vitest";
import {
  listFluxerAccountIds,
  resolveDefaultFluxerAccountId,
  resolveFluxerAccount,
} from "./accounts.js";
import type { CoreConfig } from "./types.js";

describe("Fluxer account resolution", () => {
  it("uses FLUXER_BOT_TOKEN when token is omitted", () => {
    const cfg = {
      channels: {
        fluxer: {
          baseUrl: "http://192.168.240.117/",
        },
      },
    } satisfies CoreConfig;

    expect(listFluxerAccountIds(cfg)).toEqual(["default"]);
    expect(resolveDefaultFluxerAccountId(cfg)).toBe("default");
    expect(
      resolveFluxerAccount({
        cfg,
        env: { FLUXER_BOT_TOKEN: "  bot-token  " },
      }),
    ).toMatchObject({
      accountId: "default",
      baseUrl: "http://192.168.240.117",
      apiBaseUrl: "http://192.168.240.117/api/v1",
      configured: true,
      token: "bot-token",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      requireMention: true,
      allowFrom: [],
      groupAllowFrom: [],
    });
  });

  it("infers botUserId from Fluxer bot token prefixes", () => {
    const cfg = {
      channels: {
        fluxer: {
          baseUrl: "http://fluxer.local",
          token: "Bot 1000000000000000000.secret",
        },
      },
    } satisfies CoreConfig;

    expect(resolveFluxerAccount({ cfg })).toMatchObject({
      token: "Bot 1000000000000000000.secret",
      botUserId: "1000000000000000000",
    });
  });

  it("prefers explicit botUserId over token prefixes", () => {
    const cfg = {
      channels: {
        fluxer: {
          baseUrl: "http://fluxer.local",
          token: "1000000000000000000.secret",
          botUserId: "custom-bot-user",
        },
      },
    } satisfies CoreConfig;

    expect(resolveFluxerAccount({ cfg }).botUserId).toBe("custom-bot-user");
  });

  it("merges named accounts and honors explicit API base URLs", () => {
    const cfg = {
      channels: {
        fluxer: {
          baseUrl: "http://fluxer.local",
          token: "shared",
          groupPolicy: "open",
          accounts: {
            lan: {
              apiBaseUrl: "http://fluxer.local/custom/api/",
              token: { source: "env", provider: "default", id: "LAN_FLUXER_TOKEN" },
              allowFrom: ["*"],
              dmPolicy: "open",
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(listFluxerAccountIds(cfg)).toEqual(["default", "lan"]);
    expect(
      resolveFluxerAccount({
        cfg,
        accountId: "lan",
        env: { LAN_FLUXER_TOKEN: "lan-token" },
      }),
    ).toMatchObject({
      accountId: "lan",
      apiBaseUrl: "http://fluxer.local/custom/api",
      token: "lan-token",
      allowFrom: ["*"],
      dmPolicy: "open",
      groupPolicy: "open",
    });
  });

  it("normalizes reconnect intervals to public bounds", () => {
    const cfg = {
      channels: {
        fluxer: {
          baseUrl: "http://fluxer.local",
          token: "token",
          reconnectMs: 1,
          accounts: {
            slow: { reconnectMs: 1_000_000 },
          },
        },
      },
    } satisfies CoreConfig;

    expect(resolveFluxerAccount({ cfg }).reconnectMs).toBe(100);
    expect(resolveFluxerAccount({ cfg, accountId: "slow" }).reconnectMs).toBe(60_000);
  });
});
