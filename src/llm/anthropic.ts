import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse, StopKind, ToolCall } from "./types.js";

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaTool = Anthropic.Beta.Messages.BetaTool;
type BetaCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

export interface AnthropicOptions {
  apiKey?: string;
  baseUrl?: string;
  effort?: string;
  maxTokens: number;
  /** "auto" turns the server-side refusal fallback on for models that support it. */
  fallbacks: "auto" | "default" | "off";
}

/** Models that accept the server-side `fallbacks: "default"` parameter. */
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|fable-5-1|sonnet-5-5)$/;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export class AnthropicClient implements LlmClient {
  readonly provider = "anthropic";
  private readonly client: Anthropic;
  private readonly useFallbacks: boolean;

  constructor(
    readonly model: string,
    private readonly options: AnthropicOptions,
  ) {
    // No apiKey falls through to the SDK's own resolution
    // (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).
    this.client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    });
    this.useFallbacks =
      options.fallbacks === "default" || (options.fallbacks === "auto" && FALLBACK_MODELS.test(model));
    if (options.effort && !EFFORTS.includes(options.effort)) {
      throw new Error(`Anthropic effort must be one of ${EFFORTS.join(", ")}, got "${options.effort}"`);
    }
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const tools: BetaTool[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as BetaTool["input_schema"],
    }));

    const params: BetaCreateParams = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.options.maxTokens,
      system: request.system,
      messages: toAnthropicMessages(request.messages),
      ...(tools.length ? { tools } : {}),
      // Automatic prompt caching: the frozen system prompt, the tools and the
      // append-only history form a stable prefix across every call.
      cache_control: { type: "ephemeral" },
      ...(this.options.effort
        ? { output_config: { effort: this.options.effort as "low" | "medium" | "high" | "xhigh" | "max" } }
        : {}),
      ...(this.useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    };

    const response = await this.client.beta.messages.create(params);

    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
      }
    }

    const usage = response.usage;
    return {
      text,
      toolCalls,
      stop: mapStop(response.stop_reason),
      raw: { provider: this.provider, data: response.content },
      usage: {
        inputTokens:
          usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      },
      model: response.model,
    };
  }
}

function mapStop(reason: string | null): StopKind {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

/**
 * Neutral history -> Messages API. Deterministic: the same history always
 * produces the same bytes, which keeps the prompt cache warm and keeps
 * replayed thinking blocks valid (they are bound to the exact prefix).
 */
export function toAnthropicMessages(messages: ChatMessage[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.raw?.provider === "anthropic" && Array.isArray(m.raw.data) && m.raw.data.length > 0) {
        // Replay unchanged, thinking blocks included.
        out.push({ role: "assistant", content: m.raw.data as BetaContentBlockParam[] });
        continue;
      }
      const content: BetaContentBlockParam[] = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const call of m.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }
      if (content.length === 0) content.push({ type: "text", text: "(no output)" });
      out.push({ role: "assistant", content });
    } else {
      out.push({
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.callId,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    }
  }
  return out;
}
