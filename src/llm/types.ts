/**
 * Provider-neutral conversation model. Every adapter converts to and from
 * these shapes, so sessions, tools and the rest of the system never import an
 * SDK type.
 */

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  isError?: boolean;
}

/**
 * The provider's own payload for an assistant turn. Replayed verbatim to the
 * same provider so reasoning blocks and provider-specific fields survive.
 */
export interface RawPayload {
  provider: string;
  data: unknown;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: RawPayload }
  | { role: "tool"; results: ToolResult[] };

export interface LlmRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
}

export type StopKind = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface LlmUsage {
  /** Total prompt tokens, including any served from cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
  stop: StopKind;
  raw: RawPayload;
  usage: LlmUsage;
  model: string;
}

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** Rough token estimate for providers that do not report usage. */
export function estimateTokens(messages: ChatMessage[], system = ""): number {
  let chars = system.length;
  for (const m of messages) {
    if (m.role === "user") chars += m.content.length;
    else if (m.role === "assistant") chars += m.text.length + JSON.stringify(m.toolCalls).length;
    else chars += m.results.reduce((n, r) => n + r.content.length, 0);
  }
  return Math.ceil(chars / 4);
}
