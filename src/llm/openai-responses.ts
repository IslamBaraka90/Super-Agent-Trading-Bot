import OpenAI from "openai";
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse, StopKind, ToolCall } from "./types.js";
import { parseArgs } from "./openai-compatible.js";

type InputItem = OpenAI.Responses.ResponseInputItem;
type FunctionTool = OpenAI.Responses.FunctionTool;
type Effort = NonNullable<NonNullable<OpenAI.Responses.ResponseCreateParams["reasoning"]>["effort"]>;

export interface OpenAIResponsesOptions {
  apiKey?: string;
  baseUrl?: string;
  effort?: string;
  maxTokens: number;
}

/**
 * OpenAI through the Responses API. Current reasoning models refuse function
 * tools with reasoning on Chat Completions, so this provider cannot share the
 * Chat Completions adapter the OpenAI-compatible providers use.
 *
 * Requests are stateless (`store: false`): the session's append-only history
 * is sent every time, with reasoning items replayed from their encrypted form.
 */
export class OpenAIResponsesClient implements LlmClient {
  readonly provider = "openai";
  private readonly client: OpenAI;

  constructor(
    readonly model: string,
    private readonly options: OpenAIResponsesOptions,
  ) {
    if (!model) throw new Error('Set a model name for provider "openai" (LLM_MODEL or <ROLE>_MODEL)');
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('No API key for "openai". Set OPENAI_API_KEY or LLM_API_KEY.');
    this.client = new OpenAI({ apiKey, ...(options.baseUrl ? { baseURL: options.baseUrl } : {}) });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const tools: FunctionTool[] = request.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    }));

    const response = await this.client.responses.create({
      model: this.model,
      instructions: request.system,
      input: toResponsesInput(request.messages),
      ...(tools.length ? { tools } : {}),
      max_output_tokens: request.maxTokens ?? this.options.maxTokens,
      store: false,
      include: ["reasoning.encrypted_content"],
      ...(this.options.effort ? { reasoning: { effort: this.options.effort as Effort } } : {}),
    });

    if (response.status === "failed") {
      throw new Error(`OpenAI response failed: ${response.error?.message ?? "unknown error"}`);
    }

    let text = "";
    let refused = false;
    const toolCalls: ToolCall[] = [];
    for (const item of response.output) {
      if (item.type === "message") {
        for (const part of item.content) {
          if (part.type === "output_text") text += part.text;
          else if (part.type === "refusal") refused = true;
        }
      } else if (item.type === "function_call") {
        toolCalls.push({ id: item.call_id, name: item.name, input: parseArgs(item.arguments) });
      }
    }

    return {
      text,
      toolCalls,
      stop: mapStop(response.status, response.incomplete_details?.reason, toolCalls.length > 0, refused),
      raw: { provider: this.provider, data: response.output },
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheReadTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      },
      model: response.model ?? this.model,
    };
  }
}

function mapStop(status: string | undefined, reason: string | undefined, hasTools: boolean, refused: boolean): StopKind {
  if (refused) return "refusal";
  if (status === "incomplete") {
    if (reason === "max_output_tokens") return "max_tokens";
    if (reason === "content_filter") return "refusal";
    return "other";
  }
  return hasTools ? "tool_use" : "end";
}

/** Neutral history -> Responses input. Deterministic, so the cached prefix stays stable. */
export function toResponsesInput(messages: ChatMessage[]): InputItem[] {
  const out: InputItem[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.raw?.provider === "openai" && Array.isArray(m.raw.data) && m.raw.data.length > 0) {
        // Replay unchanged, reasoning items included.
        out.push(...(m.raw.data as InputItem[]));
        continue;
      }
      if (m.text) out.push({ role: "assistant", content: m.text });
      for (const call of m.toolCalls) {
        out.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) });
      }
    } else {
      for (const r of m.results) {
        out.push({ type: "function_call_output", call_id: r.callId, output: r.isError ? `ERROR: ${r.content}` : r.content });
      }
    }
  }
  return out;
}
