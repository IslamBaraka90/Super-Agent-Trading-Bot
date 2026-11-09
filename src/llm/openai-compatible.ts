import OpenAI from "openai";
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse, StopKind, ToolCall } from "./types.js";

type ChatParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

/**
 * Presets for providers that speak the OpenAI Chat Completions protocol.
 * `LLM_BASE_URL` / `<ROLE>_BASE_URL` overrides the URL for any of them.
 */
export const OPENAI_COMPATIBLE_PRESETS: Record<string, { baseUrl?: string; keyEnv?: string }> = {
  deepseek: { baseUrl: "https://api.deepseek.com", keyEnv: "DEEPSEEK_API_KEY" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
  xai: { baseUrl: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", keyEnv: "GEMINI_API_KEY" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY" },
  together: { baseUrl: "https://api.together.xyz/v1", keyEnv: "TOGETHER_API_KEY" },
  ollama: { baseUrl: "http://localhost:11434/v1" },
  "openai-compatible": {},
};

/** Reasoning fields some providers require back on the next request of a tool loop. */
const PASSTHROUGH_FIELDS = ["reasoning_content", "reasoning", "reasoning_details"] as const;

export interface OpenAICompatibleOptions {
  apiKey?: string;
  baseUrl?: string;
  effort?: string;
  maxTokens: number;
}

export class OpenAICompatibleClient implements LlmClient {
  private readonly client: OpenAI;

  constructor(
    readonly provider: string,
    readonly model: string,
    private readonly options: OpenAICompatibleOptions,
  ) {
    const preset = OPENAI_COMPATIBLE_PRESETS[provider];
    if (!preset) throw new Error(`Unknown OpenAI-compatible provider "${provider}"`);
    const baseURL = options.baseUrl ?? preset.baseUrl;
    if (provider === "openai-compatible" && !baseURL) {
      throw new Error("LLM_BASE_URL is required for provider openai-compatible");
    }
    if (!model) throw new Error(`Set a model name for provider "${provider}" (LLM_MODEL or <ROLE>_MODEL)`);
    const apiKey =
      options.apiKey ?? (preset.keyEnv ? process.env[preset.keyEnv] : undefined) ?? (provider === "ollama" ? "ollama" : undefined);
    if (!apiKey) {
      throw new Error(`No API key for "${provider}". Set ${preset.keyEnv ?? "LLM_API_KEY"} or LLM_API_KEY.`);
    }
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const tools: ChatTool[] = request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    const maxTokens = request.maxTokens ?? this.options.maxTokens;

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(request.system, request.messages, this.provider),
      ...(tools.length ? { tools } : {}),
      max_tokens: maxTokens,
      ...(this.options.effort
        ? { reasoning_effort: this.options.effort as OpenAI.Chat.Completions.ChatCompletionCreateParams["reasoning_effort"] }
        : {}),
    });

    const choice = response.choices[0];
    if (!choice) throw new Error(`${this.provider} returned no choices`);
    const message = choice.message;
    const toolCalls: ToolCall[] = [];
    for (const call of message.tool_calls ?? []) {
      if (call.type !== "function") continue;
      toolCalls.push({ id: call.id, name: call.function.name, input: parseArgs(call.function.arguments) });
    }

    const raw: Record<string, unknown> = { content: message.content ?? null };
    if (message.tool_calls?.length) raw.tool_calls = message.tool_calls;
    const extra = message as unknown as Record<string, unknown>;
    for (const field of PASSTHROUGH_FIELDS) {
      if (extra[field] !== undefined && extra[field] !== null) raw[field] = extra[field];
    }

    const cached =
      (response.usage as unknown as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)
        ?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      text: message.content ?? "",
      toolCalls,
      stop: mapFinish(choice.finish_reason, toolCalls.length > 0),
      raw: { provider: this.provider, data: raw },
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        cacheReadTokens: cached,
      },
      model: response.model ?? this.model,
    };
  }
}

export function parseArgs(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : { value };
  } catch {
    // Surface the problem to the tool validator instead of throwing mid-turn.
    return { __invalid_json: text };
  }
}

function mapFinish(reason: string | null | undefined, hasTools: boolean): StopKind {
  if (hasTools) return "tool_use";
  switch (reason) {
    case "stop":
      return "end";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return reason ? "other" : "end";
  }
}

export function toOpenAIMessages(system: string, messages: ChatMessage[], provider: string): ChatParam[] {
  const out: ChatParam[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.raw?.provider === provider && m.raw.data && typeof m.raw.data === "object") {
        out.push({ role: "assistant", ...(m.raw.data as object) } as ChatParam);
        continue;
      }
      out.push({
        role: "assistant",
        content: m.text || null,
        ...(m.toolCalls.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.input) },
              })),
            }
          : {}),
      });
    } else {
      for (const r of m.results) {
        out.push({ role: "tool", tool_call_id: r.callId, content: r.isError ? `ERROR: ${r.content}` : r.content });
      }
    }
  }
  return out;
}
