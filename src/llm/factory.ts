import type { Config, LlmRole } from "../config.js";
import type { LlmClient } from "./types.js";
import { AnthropicClient } from "./anthropic.js";
import { OPENAI_COMPATIBLE_PRESETS, OpenAICompatibleClient } from "./openai-compatible.js";
import { MockLlm } from "./mock.js";

export const PROVIDERS = ["anthropic", ...Object.keys(OPENAI_COMPATIBLE_PRESETS), "mock"];

/** Build the client for one role from its `<ROLE>_PROVIDER` / `<ROLE>_MODEL` settings. */
export function createLlmClient(role: LlmRole, config: Config): LlmClient {
  const c = config.llm[role];
  if (c.provider === "anthropic") {
    return new AnthropicClient(c.model, {
      apiKey: c.apiKey,
      baseUrl: c.baseUrl,
      effort: c.effort,
      maxTokens: c.maxTokens,
      fallbacks: config.anthropicFallbacks,
    });
  }
  if (c.provider === "mock") return new MockLlm(role, config);
  if (OPENAI_COMPATIBLE_PRESETS[c.provider]) {
    return new OpenAICompatibleClient(c.provider, c.model, {
      apiKey: c.apiKey,
      baseUrl: c.baseUrl,
      effort: c.effort,
      maxTokens: c.maxTokens,
    });
  }
  throw new Error(`Unknown provider "${c.provider}" for ${role}. Use one of: ${PROVIDERS.join(", ")}`);
}
