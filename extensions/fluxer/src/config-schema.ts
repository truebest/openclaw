/**
 * Zod-backed config schema for Fluxer channel accounts.
 */
import {
  DmPolicySchema,
  GroupPolicySchema,
  ToolPolicySchema,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const FluxerGroupConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    allowFrom: z.array(z.string()).optional(),
    tools: ToolPolicySchema.optional(),
    toolsBySender: z.record(z.string(), ToolPolicySchema).optional(),
  })
  .strict();

const FluxerAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    baseUrl: z.string().url().optional(),
    apiBaseUrl: z.string().url().optional(),
    gatewayUrl: z.string().url().optional(),
    token: buildSecretInputSchema().optional(),
    botUserId: z.string().optional(),
    agentId: z.string().optional(),
    defaultTo: z.string().optional(),
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    requireMention: z.boolean().optional(),
    groups: z.record(z.string(), FluxerGroupConfigSchema).optional(),
    reconnectMs: z.number().int().min(100).max(60_000).optional(),
  })
  .strict();

const FluxerConfigSchema = FluxerAccountConfigSchema.extend({
  accounts: z.record(z.string(), FluxerAccountConfigSchema.partial()).optional(),
  defaultAccount: z.string().optional(),
}).strict();

/**
 * Config schema exported to core so `openclaw doctor` and config validation
 * understand both default and named Fluxer accounts.
 */
export const fluxerConfigSchema: ReturnType<typeof buildChannelConfigSchema> =
  buildChannelConfigSchema(FluxerConfigSchema);
