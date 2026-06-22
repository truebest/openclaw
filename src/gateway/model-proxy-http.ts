// Internal raw model proxy endpoint for worker gateways.
// Unlike /v1/chat/completions, this dispatches directly to the provider simple
// completion runtime and does not run an OpenClaw agent turn.
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { prepareSimpleCompletionModel } from "../agents/simple-completion-runtime.js";
import { prepareModelForSimpleCompletion } from "../agents/simple-completion-transport.js";
import {
  hasNonzeroUsage,
  makeZeroUsageSnapshot,
  normalizeUsage,
  toOpenAiChatCompletionsUsage,
} from "../agents/usage.js";
import type { GatewayHttpModelProxyConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { streamSimple } from "../llm/stream.js";
import type {
  AssistantMessage,
  Context,
  Message,
  SimpleStreamOptions,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "../llm/types.js";
import { logWarn } from "../logger.js";
import {
  readJsonBodyOrError,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  setSseHeaders,
  watchClientDisconnect,
  writeDone,
} from "./http-common.js";
import { resolveOpenAiCompatError, validateOpenAiSamplingParams } from "./openai-compat-errors.js";
import { resolveConfiguredSecretInputString } from "./resolve-configured-secret-input-string.js";

type ModelProxyRequest = {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  stream_options?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  stop?: unknown;
  user?: unknown;
};

type ResolvedModelRef = {
  provider: string;
  modelId: string;
  ref: string;
  requestedProvider: string;
  requestedModelId: string;
  requestedRef: string;
  preferredProfile?: string;
};

type PreparedProxyRequest = {
  request: ModelProxyRequest;
  modelRef: ResolvedModelRef;
  context: Context;
  toolChoice?: unknown;
  options: SimpleStreamOptions & Record<string, unknown>;
  stream: boolean;
  includeUsage: boolean;
};

const MODEL_PROXY_PATH = "/llm/v1/chat/completions";
const DEFAULT_MODEL_PROXY_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MODEL_PROXY_AGENT_ID = "main";
const DEFAULT_MODEL_PROXY_PROVIDER = "openai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeModelRef(raw: string, defaultProvider: string): ResolvedModelRef {
  const slash = raw.indexOf("/");
  const provider = slash > 0 ? raw.slice(0, slash).trim() : defaultProvider;
  const modelId = slash > 0 ? raw.slice(slash + 1).trim() : raw.trim();
  if (!provider || !modelId) {
    throw new Error("model must be a non-empty model id or provider/model ref");
  }
  return {
    provider,
    modelId,
    ref: `${provider}/${modelId}`,
    requestedProvider: provider,
    requestedModelId: modelId,
    requestedRef: `${provider}/${modelId}`,
  };
}

function routeTarget(params: {
  route: NonNullable<GatewayHttpModelProxyConfig["routes"]>[string];
  defaultProvider: string;
}): { target: string; preferredProfile?: string } {
  const route = params.route;
  if (typeof route === "string") {
    const target = normalizeOptionalString(route);
    if (!target) {
      throw new Error("model proxy route target must be non-empty");
    }
    return { target };
  }
  if (!isRecord(route)) {
    throw new Error("model proxy route must be a string or object");
  }
  const preferredProfile = normalizeOptionalString(route.preferredProfile);
  const explicitTarget = normalizeOptionalString(route.target);
  if (explicitTarget) {
    return { target: explicitTarget, ...(preferredProfile ? { preferredProfile } : {}) };
  }
  const provider = normalizeOptionalString(route.provider) ?? params.defaultProvider;
  const model = normalizeOptionalString(route.model);
  if (!model) {
    throw new Error("model proxy route requires target or model");
  }
  const target =
    model.includes("/") && !normalizeOptionalString(route.provider)
      ? model
      : `${provider}/${model}`;
  return { target, ...(preferredProfile ? { preferredProfile } : {}) };
}

function resolveModelRoute(params: {
  rawModel: string;
  requested: ResolvedModelRef;
  config: GatewayHttpModelProxyConfig | undefined;
  defaultProvider: string;
}): { target: string; preferredProfile?: string } | undefined {
  const routes = params.config?.routes;
  if (!routes || typeof routes !== "object") {
    return undefined;
  }
  const raw = params.rawModel.trim();
  const route = routes[raw] ?? routes[params.requested.modelId] ?? routes[params.requested.ref];
  if (route === undefined) {
    return undefined;
  }
  return routeTarget({ route, defaultProvider: params.defaultProvider });
}

function resolveRequestModel(params: {
  request: ModelProxyRequest;
  config: GatewayHttpModelProxyConfig | undefined;
}): ResolvedModelRef {
  const defaultProvider =
    normalizeOptionalString(params.config?.defaultProvider) ?? DEFAULT_MODEL_PROXY_PROVIDER;
  const rawModel =
    normalizeString(params.request.model) ?? normalizeOptionalString(params.config?.defaultModel);
  if (!rawModel) {
    throw new Error("model is required");
  }
  const requested = normalizeModelRef(rawModel, defaultProvider);
  const route = resolveModelRoute({
    rawModel,
    requested,
    config: params.config,
    defaultProvider,
  });
  const resolved = route ? normalizeModelRef(route.target, defaultProvider) : requested;
  return {
    ...resolved,
    requestedProvider: requested.provider,
    requestedModelId: requested.modelId,
    requestedRef: requested.ref,
    ...(route?.preferredProfile ? { preferredProfile: route.preferredProfile } : {}),
  };
}

function assertModelAllowed(params: {
  modelRef: ResolvedModelRef;
  config: GatewayHttpModelProxyConfig | undefined;
}) {
  const defaultProvider =
    normalizeOptionalString(params.config?.defaultProvider) ?? DEFAULT_MODEL_PROXY_PROVIDER;
  const allowed = params.config?.allowedModels
    ?.map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => normalizeModelRef(entry, defaultProvider).ref);
  if (!allowed || allowed.length === 0) {
    return;
  }
  if (!allowed.includes(params.modelRef.ref)) {
    if (allowed.includes(params.modelRef.requestedRef)) {
      return;
    }
    throw new Error(`model ${params.modelRef.ref} is not allowed by this proxy`);
  }
}

function parseJsonObject(value: string, context: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to the consistent error below.
  }
  throw new Error(`${context} must be a JSON object`);
}

function textBlocksFromContent(content: unknown, context: string): TextContent[] {
  if (content == null) {
    return [];
  }
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    throw new Error(`${context}.content must be a string or text content array`);
  }
  const blocks: TextContent[] = [];
  for (const [index, part] of content.entries()) {
    if (!isRecord(part)) {
      throw new Error(`${context}.content[${index}] must be an object`);
    }
    const type = normalizeString(part.type);
    if (type === "text" || type === "input_text") {
      if (typeof part.text !== "string") {
        throw new Error(`${context}.content[${index}].text must be a string`);
      }
      if (part.text) {
        blocks.push({ type: "text", text: part.text });
      }
      continue;
    }
    throw new Error(`${context}.content[${index}] type "${type ?? ""}" is not supported`);
  }
  return blocks;
}

function textFromContent(content: unknown, context: string): string {
  return textBlocksFromContent(content, context)
    .map((block) => block.text)
    .join("\n");
}

function parseToolCalls(value: unknown): ToolCall[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("assistant.tool_calls must be an array");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`assistant.tool_calls[${index}] must be an object`);
    }
    const id = normalizeString(entry.id) ?? `call_${index}`;
    const fn = entry.function;
    if (!isRecord(fn)) {
      throw new Error(`assistant.tool_calls[${index}].function is required`);
    }
    const name = normalizeString(fn.name);
    if (!name) {
      throw new Error(`assistant.tool_calls[${index}].function.name is required`);
    }
    const rawArgs = typeof fn.arguments === "string" ? fn.arguments : "{}";
    return {
      type: "toolCall",
      id,
      name,
      arguments: parseJsonObject(
        rawArgs || "{}",
        `assistant.tool_calls[${index}].function.arguments`,
      ),
    };
  });
}

function zeroUsage(): Usage {
  return makeZeroUsageSnapshot();
}

function buildAssistantMessage(params: {
  modelRef: ResolvedModelRef;
  message: Record<string, unknown>;
  toolCalls: ToolCall[];
}): AssistantMessage {
  const text = textFromContent(params.message.content, "assistant");
  return {
    role: "assistant",
    api: "openai-completions",
    provider: params.modelRef.provider,
    model: params.modelRef.modelId,
    content: [...(text ? [{ type: "text" as const, text }] : []), ...params.toolCalls],
    usage: zeroUsage(),
    stopReason: params.toolCalls.length > 0 ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

function buildContext(params: { request: ModelProxyRequest; modelRef: ResolvedModelRef }): Context {
  if (!Array.isArray(params.request.messages)) {
    throw new Error("messages must be an array");
  }
  const systemParts: string[] = [];
  const messages: Message[] = [];
  const toolNamesById = new Map<string, string>();
  for (const [index, rawMessage] of params.request.messages.entries()) {
    if (!isRecord(rawMessage)) {
      throw new Error(`messages[${index}] must be an object`);
    }
    const role = normalizeString(rawMessage.role);
    if (role === "system" || role === "developer") {
      const text = textFromContent(rawMessage.content, `messages[${index}]`);
      if (text) {
        systemParts.push(text);
      }
      continue;
    }
    if (role === "user") {
      messages.push({
        role: "user",
        content: textBlocksFromContent(rawMessage.content, `messages[${index}]`),
        timestamp: Date.now(),
      });
      continue;
    }
    if (role === "assistant") {
      const toolCalls = parseToolCalls(rawMessage.tool_calls);
      for (const call of toolCalls) {
        toolNamesById.set(call.id, call.name);
      }
      messages.push(
        buildAssistantMessage({
          modelRef: params.modelRef,
          message: rawMessage,
          toolCalls,
        }),
      );
      continue;
    }
    if (role === "tool") {
      const toolCallId = normalizeString(rawMessage.tool_call_id);
      if (!toolCallId) {
        throw new Error(`messages[${index}].tool_call_id is required`);
      }
      const toolName = toolNamesById.get(toolCallId) ?? "tool";
      const toolMessage: ToolResultMessage = {
        role: "toolResult",
        toolCallId,
        toolName,
        content: textBlocksFromContent(rawMessage.content, `messages[${index}]`),
        isError: false,
        timestamp: Date.now(),
      };
      messages.push(toolMessage);
      continue;
    }
    throw new Error(`messages[${index}].role is unsupported`);
  }
  if (messages.length === 0) {
    throw new Error("messages must include at least one user, assistant, or tool message");
  }
  const tools = extractTools(params.request.tools);
  return {
    ...(systemParts.length > 0 ? { systemPrompt: systemParts.join("\n\n") } : {}),
    messages,
    ...(tools.length > 0 ? { tools } : {}),
  };
}

function extractTools(tools: unknown): Tool[] {
  if (tools == null) {
    return [];
  }
  if (!Array.isArray(tools)) {
    throw new Error("tools must be an array");
  }
  return tools.map((tool, index) => {
    if (!isRecord(tool)) {
      throw new Error(`tools[${index}] must be an object`);
    }
    if (tool.type !== "function") {
      throw new Error(`tools[${index}].type must be "function"`);
    }
    if (!isRecord(tool.function)) {
      throw new Error(`tools[${index}].function is required`);
    }
    const name = normalizeString(tool.function.name);
    if (!name) {
      throw new Error(`tools[${index}].function.name is required`);
    }
    const description =
      typeof tool.function.description === "string" ? tool.function.description : "";
    const parameters = isRecord(tool.function.parameters)
      ? tool.function.parameters
      : { type: "object", properties: {} };
    return {
      name,
      description,
      parameters: parameters as Tool["parameters"],
    };
  });
}

function normalizeToolChoice(toolChoice: unknown): unknown {
  if (toolChoice == null || toolChoice === "auto" || toolChoice === "none") {
    return toolChoice;
  }
  if (toolChoice === "required") {
    return "required";
  }
  if (isRecord(toolChoice) && toolChoice.type === "function" && isRecord(toolChoice.function)) {
    const name = normalizeString(toolChoice.function.name);
    if (!name) {
      throw new Error("tool_choice.function.name is required");
    }
    return { type: "function", function: { name } };
  }
  throw new Error("unsupported tool_choice");
}

function normalizePositiveInteger(value: unknown, field: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return Math.trunc(value);
}

function normalizeStop(value: unknown): string[] | undefined {
  if (value == null) {
    return undefined;
  }
  const raw = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
  if (!raw) {
    throw new Error("stop must be a string or string array");
  }
  if (raw.length > 4) {
    throw new Error("stop must contain no more than 4 sequences");
  }
  const stop = raw.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error("stop entries must be non-empty strings");
    }
    return entry;
  });
  return stop.length > 0 ? stop : undefined;
}

function prepareProxyRequest(params: {
  body: unknown;
  config: GatewayHttpModelProxyConfig | undefined;
}): PreparedProxyRequest {
  if (!isRecord(params.body)) {
    throw new Error("request body must be an object");
  }
  const request = params.body as ModelProxyRequest;
  const samplingError = validateOpenAiSamplingParams({
    temperature: request.temperature,
    topP: request.top_p,
  });
  if (samplingError) {
    throw new Error(samplingError);
  }
  const modelRef = resolveRequestModel({ request, config: params.config });
  assertModelAllowed({ modelRef, config: params.config });
  const context = buildContext({ request, modelRef });
  const toolChoice = normalizeToolChoice(request.tool_choice);
  const maxTokens = normalizePositiveInteger(
    request.max_completion_tokens ?? request.max_tokens,
    "max_completion_tokens",
  );
  const stop = normalizeStop(request.stop);
  const includeUsage =
    isRecord(request.stream_options) && request.stream_options.include_usage === true;
  return {
    request,
    modelRef,
    context,
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    options: {
      ...(maxTokens ? { maxTokens } : {}),
      ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
      ...(typeof request.top_p === "number" ? { top_p: request.top_p } : {}),
      ...(stop ? { stop } : {}),
      ...(typeof request.user === "string" && request.user.trim()
        ? { sessionId: request.user.trim() }
        : {}),
    },
    stream: request.stream === true,
    includeUsage,
  };
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

async function resolveModelProxyToken(params: {
  config: GatewayHttpModelProxyConfig | undefined;
  fullConfig: OpenClawConfig;
}): Promise<string | undefined> {
  const configured = params.config?.token;
  const configuredRef = resolveSecretInputRef({
    value: configured,
    defaults: params.fullConfig.secrets?.defaults,
  }).ref;
  if (configured !== undefined || configuredRef) {
    const resolved = await resolveConfiguredSecretInputString({
      config: params.fullConfig,
      env: process.env,
      value: configured,
      path: "gateway.http.endpoints.modelProxy.token",
      unresolvedReasonStyle: "generic",
    });
    if (resolved.value) {
      return resolved.value;
    }
    logWarn(resolved.unresolvedRefReason ?? "model proxy token is configured but unavailable");
    return undefined;
  }
  return normalizeOptionalString(process.env.LLM_HUB_TOKEN);
}

async function authorizeModelProxyRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  config: GatewayHttpModelProxyConfig | undefined;
  fullConfig: OpenClawConfig;
}): Promise<boolean> {
  const expected = await resolveModelProxyToken(params);
  if (!expected) {
    sendJson(params.res, 503, {
      error: {
        message: "model proxy token is not configured",
        type: "configuration_error",
      },
    });
    return false;
  }
  const provided = bearerToken(params.req);
  if (!provided || !constantTimeEquals(provided, expected)) {
    sendJson(params.res, 401, {
      error: { message: "Unauthorized", type: "unauthorized" },
    });
    return false;
  }
  return true;
}

async function createProxyStream(params: {
  cfg: OpenClawConfig;
  proxyConfig: GatewayHttpModelProxyConfig | undefined;
  prepared: PreparedProxyRequest;
  signal: AbortSignal;
}) {
  const agentId =
    normalizeOptionalString(params.proxyConfig?.agentId) ?? DEFAULT_MODEL_PROXY_AGENT_ID;
  const agentDir = resolveAgentDir(params.cfg, agentId);
  const preferredProfile =
    normalizeOptionalString(params.prepared.modelRef.preferredProfile) ??
    normalizeOptionalString(params.proxyConfig?.preferredProfile);
  const preparedModel = await prepareSimpleCompletionModel({
    cfg: params.cfg,
    provider: params.prepared.modelRef.provider,
    modelId: params.prepared.modelRef.modelId,
    agentDir,
    ...(preferredProfile ? { preferredProfile } : {}),
    allowBundledStaticCatalogFallback: true,
    useAsyncModelResolution: true,
  });
  if ("error" in preparedModel) {
    throw new Error(preparedModel.error);
  }
  const model = prepareModelForSimpleCompletion({
    model: preparedModel.model,
    cfg: params.cfg,
  });
  return streamSimple(model, params.prepared.context, {
    ...params.prepared.options,
    ...(params.prepared.toolChoice !== undefined ? { toolChoice: params.prepared.toolChoice } : {}),
    signal: params.signal,
    apiKey: preparedModel.auth.apiKey,
  });
}

function assistantText(message: AssistantMessage): string | null {
  const text = message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");
  return text.length > 0 ? text : null;
}

function assistantToolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

function openAiUsage(message: AssistantMessage) {
  const usage = normalizeUsage(message.usage);
  return hasNonzeroUsage(usage) ? toOpenAiChatCompletionsUsage(usage) : undefined;
}

function finishReason(message: AssistantMessage): "stop" | "length" | "tool_calls" {
  if (message.stopReason === "toolUse" || assistantToolCalls(message).length > 0) {
    return "tool_calls";
  }
  if (message.stopReason === "length") {
    return "length";
  }
  return "stop";
}

function openAiToolCalls(message: AssistantMessage) {
  return assistantToolCalls(message).map((call) => ({
    id: call.id,
    type: "function" as const,
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
    },
  }));
}

function buildCompletionJson(message: AssistantMessage, requestedModel: string) {
  const toolCalls = openAiToolCalls(message);
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: unixSeconds(),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: assistantText(message),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason(message),
      },
    ],
    ...(openAiUsage(message) ? { usage: openAiUsage(message) } : {}),
  };
}

function sendCompletionJson(
  res: ServerResponse,
  message: AssistantMessage,
  requestedModel: string,
) {
  sendJson(res, 200, buildCompletionJson(message, requestedModel));
}

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamChunk(params: {
  id: string;
  model: string;
  delta: Record<string, unknown>;
  finishReason?: "stop" | "length" | "tool_calls";
  usage?: unknown;
}) {
  return {
    id: params.id,
    object: "chat.completion.chunk",
    created: unixSeconds(),
    model: params.model,
    choices: [
      {
        index: 0,
        delta: params.delta,
        finish_reason: params.finishReason ?? null,
      },
    ],
    ...(params.usage ? { usage: params.usage } : {}),
  };
}

async function sendCompletionStream(params: {
  req: IncomingMessage;
  res: ServerResponse;
  stream: Awaited<ReturnType<typeof createProxyStream>>;
  requestedModel: string;
  includeUsage: boolean;
}) {
  const id = `chatcmpl-${randomUUID()}`;
  setSseHeaders(params.res);
  writeSse(
    params.res,
    streamChunk({
      id,
      model: params.requestedModel,
      delta: { role: "assistant" },
    }),
  );
  const emittedTextIndexes = new Set<number>();
  let finalMessage: AssistantMessage | undefined;
  for await (const event of params.stream) {
    if (event.type === "text_delta") {
      emittedTextIndexes.add(event.contentIndex);
      writeSse(
        params.res,
        streamChunk({
          id,
          model: params.requestedModel,
          delta: { content: event.delta },
        }),
      );
      continue;
    }
    if (event.type === "text_end" && !emittedTextIndexes.has(event.contentIndex)) {
      writeSse(
        params.res,
        streamChunk({
          id,
          model: params.requestedModel,
          delta: { content: event.content },
        }),
      );
      continue;
    }
    if (event.type === "toolcall_end") {
      writeSse(
        params.res,
        streamChunk({
          id,
          model: params.requestedModel,
          delta: {
            tool_calls: [
              {
                index: event.contentIndex,
                id: event.toolCall.id,
                type: "function",
                function: {
                  name: event.toolCall.name,
                  arguments: JSON.stringify(event.toolCall.arguments ?? {}),
                },
              },
            ],
          },
        }),
      );
      continue;
    }
    if (event.type === "done") {
      finalMessage = event.message;
      break;
    }
    if (event.type === "error") {
      finalMessage = event.error;
      writeSse(params.res, {
        error: {
          message: event.error.errorMessage ?? "upstream provider error",
          type: event.error.errorType ?? "api_error",
          ...(event.error.errorCode ? { code: event.error.errorCode } : {}),
        },
      });
      writeDone(params.res);
      params.res.end();
      return;
    }
  }
  finalMessage ??= await params.stream.result();
  const usage = params.includeUsage ? openAiUsage(finalMessage) : undefined;
  writeSse(
    params.res,
    streamChunk({
      id,
      model: params.requestedModel,
      delta: {},
      finishReason: finishReason(finalMessage),
      ...(usage ? { usage } : {}),
    }),
  );
  writeDone(params.res);
  params.res.end();
}

function sendProxyError(res: ServerResponse, error: unknown) {
  const compat = resolveOpenAiCompatError(error);
  if (compat) {
    sendJson(res, compat.status, compat);
    return;
  }
  sendJson(res, 502, {
    error: {
      message: formatErrorMessage(error) || "model proxy request failed",
      type: "api_error",
    },
  });
}

export async function handleModelProxyChatCompletionsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    config?: GatewayHttpModelProxyConfig;
    fullConfig: OpenClawConfig;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== MODEL_PROXY_PATH) {
    return false;
  }
  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }
  if (
    !(await authorizeModelProxyRequest({
      req,
      res,
      config: opts.config,
      fullConfig: opts.fullConfig,
    }))
  ) {
    return true;
  }
  const body = await readJsonBodyOrError(
    req,
    res,
    opts.config?.maxBodyBytes ?? DEFAULT_MODEL_PROXY_MAX_BODY_BYTES,
  );
  if (body === undefined) {
    return true;
  }
  let prepared: PreparedProxyRequest;
  try {
    prepared = prepareProxyRequest({ body, config: opts.config });
  } catch (error) {
    sendInvalidRequest(res, formatErrorMessage(error));
    return true;
  }
  const abortController = new AbortController();
  const cleanupDisconnect = watchClientDisconnect(req, res, abortController);
  try {
    const modelStream = await createProxyStream({
      cfg: opts.fullConfig,
      proxyConfig: opts.config,
      prepared,
      signal: abortController.signal,
    });
    if (prepared.stream) {
      await sendCompletionStream({
        req,
        res,
        stream: modelStream,
        requestedModel: prepared.modelRef.requestedModelId,
        includeUsage: prepared.includeUsage,
      });
      return true;
    }
    const result = await modelStream.result();
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      sendProxyError(res, new Error(result.errorMessage ?? "upstream provider error"));
      return true;
    }
    sendCompletionJson(res, result, prepared.modelRef.requestedModelId);
    return true;
  } catch (error) {
    sendProxyError(res, error);
    return true;
  } finally {
    cleanupDisconnect();
  }
}

export const testing = {
  buildCompletionJson,
  buildContext,
  normalizeModelRef,
  prepareProxyRequest,
};
