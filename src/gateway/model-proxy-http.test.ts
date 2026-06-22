import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AssistantMessage } from "../llm/types.js";
import { handleModelProxyChatCompletionsHttpRequest, testing } from "./model-proxy-http.js";
import { createRequest, createResponse } from "./server-http.test-harness.js";

const savedLlmHubToken = process.env.LLM_HUB_TOKEN;

beforeEach(() => {
  process.env.LLM_HUB_TOKEN = "hub-secret";
});

afterEach(() => {
  if (savedLlmHubToken === undefined) {
    delete process.env.LLM_HUB_TOKEN;
  } else {
    process.env.LLM_HUB_TOKEN = savedLlmHubToken;
  }
});

describe("model proxy chat completions request preparation", () => {
  it("normalizes bare model ids through the configured default provider", () => {
    const prepared = testing.prepareProxyRequest({
      body: {
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hello" }],
      },
      config: { defaultProvider: "openclaw-llm", allowedModels: ["openclaw-llm/gpt-5.5"] },
    });

    expect(prepared.modelRef).toEqual({
      provider: "openclaw-llm",
      modelId: "gpt-5.5",
      ref: "openclaw-llm/gpt-5.5",
      requestedProvider: "openclaw-llm",
      requestedModelId: "gpt-5.5",
      requestedRef: "openclaw-llm/gpt-5.5",
    });
    expect(prepared.context.messages).toHaveLength(1);
    expect(prepared.stream).toBe(false);
  });

  it("uses the configured default model when the request omits model", () => {
    const prepared = testing.prepareProxyRequest({
      body: { messages: [{ role: "user", content: "hello" }] },
      config: { defaultProvider: "openai", defaultModel: "gpt-5.5" },
    });

    expect(prepared.modelRef.ref).toBe("openai/gpt-5.5");
  });

  it("routes exposed model aliases to upstream provider model refs", () => {
    const prepared = testing.prepareProxyRequest({
      body: {
        model: "codex-spark",
        messages: [{ role: "user", content: "hello" }],
      },
      config: {
        defaultProvider: "openai",
        routes: {
          "codex-spark": "openai/gpt-5.3-codex-spark",
        },
        allowedModels: ["codex-spark"],
      },
    });

    expect(prepared.modelRef).toMatchObject({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      ref: "openai/gpt-5.3-codex-spark",
      requestedProvider: "openai",
      requestedModelId: "codex-spark",
      requestedRef: "openai/codex-spark",
    });
  });

  it("routes object entries and preserves per-route preferred profiles", () => {
    const prepared = testing.prepareProxyRequest({
      body: {
        model: "openai/ops",
        messages: [{ role: "user", content: "hello" }],
      },
      config: {
        defaultProvider: "openai",
        routes: {
          "openai/ops": {
            model: "gpt-5.3-codex-spark",
            preferredProfile: "ops-profile",
          },
        },
        allowedModels: ["openai/gpt-5.3-codex-spark"],
      },
    });

    expect(prepared.modelRef).toMatchObject({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      requestedProvider: "openai",
      requestedModelId: "ops",
      requestedRef: "openai/ops",
      preferredProfile: "ops-profile",
    });
  });

  it("rejects models outside the proxy allowlist", () => {
    expect(() =>
      testing.prepareProxyRequest({
        body: {
          model: "other-model",
          messages: [{ role: "user", content: "hello" }],
        },
        config: { defaultProvider: "openai", allowedModels: ["openai/gpt-5.5"] },
      }),
    ).toThrow("not allowed");
  });

  it("converts OpenAI messages, tools, and tool choice into llm-core context", () => {
    const prepared = testing.prepareProxyRequest({
      body: {
        model: "openai/gpt-5.5",
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 123,
        temperature: 0.4,
        stop: ["STOP"],
        user: "session-1",
        messages: [
          { role: "system", content: "You are concise." },
          { role: "developer", content: "Prefer JSON." },
          { role: "user", content: [{ type: "text", text: "lookup weather" }] },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"city":"Paris"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "sunny" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Lookup data",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "lookup" } },
      },
      config: undefined,
    });

    expect(prepared.context.systemPrompt).toBe("You are concise.\n\nPrefer JSON.");
    expect(prepared.context.messages).toHaveLength(3);
    expect(prepared.context.tools?.[0]?.name).toBe("lookup");
    expect(prepared.toolChoice).toEqual({ type: "function", function: { name: "lookup" } });
    expect(prepared.options).toMatchObject({
      maxTokens: 123,
      temperature: 0.4,
      stop: ["STOP"],
      sessionId: "session-1",
    });
    expect(prepared.stream).toBe(true);
    expect(prepared.includeUsage).toBe(true);
  });

  it("keeps the MVP text-only boundary explicit", () => {
    expect(() =>
      testing.prepareProxyRequest({
        body: {
          model: "openai/gpt-5.5",
          messages: [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }],
            },
          ],
        },
        config: undefined,
      }),
    ).toThrow("is not supported");
  });

  it("keeps routed aliases in OpenAI-compatible response envelopes", () => {
    const response = testing.buildCompletionJson(
      {
        role: "assistant",
        api: "openai-completions",
        provider: "openai",
        model: "gpt-5.3-codex-spark",
        responseModel: "gpt-5.3-codex-spark",
        content: [{ type: "text", text: "ok" }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      } satisfies AssistantMessage,
      "codex-spark",
    );

    expect(response.model).toBe("codex-spark");
    expect(response.choices[0]?.message.content).toBe("ok");
  });
});

describe("handleModelProxyChatCompletionsHttpRequest", () => {
  it("rejects requests without the model proxy bearer token before reading the body", async () => {
    const req = createRequest({
      path: "/llm/v1/chat/completions",
      method: "POST",
      authorization: "Bearer wrong",
    }) as IncomingMessage;
    const { res, getBody } = createResponse();

    const handled = await handleModelProxyChatCompletionsHttpRequest(req, res, {
      fullConfig: {} as OpenClawConfig,
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(getBody())).toEqual({
      error: { message: "Unauthorized", type: "unauthorized" },
    });
  });
});
