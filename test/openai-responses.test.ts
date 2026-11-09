import { test } from "node:test";
import assert from "node:assert/strict";
import { toResponsesInput } from "../src/llm/openai-responses.js";
import type { ChatMessage } from "../src/llm/types.js";

test("OpenAI's own output items are replayed unchanged, reasoning included", () => {
  const output = [
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "add", arguments: '{"a":2}' },
  ];
  const messages: ChatMessage[] = [
    { role: "user", content: "add" },
    { role: "assistant", text: "", toolCalls: [{ id: "call_1", name: "add", input: { a: 2 } }], raw: { provider: "openai", data: output } },
    { role: "tool", results: [{ callId: "call_1", name: "add", content: "2" }] },
  ];
  assert.deepEqual(toResponsesInput(messages), [
    { role: "user", content: "add" },
    ...output,
    { type: "function_call_output", call_id: "call_1", output: "2" },
  ]);
});

test("a turn from another provider is rebuilt from its neutral form", () => {
  const messages: ChatMessage[] = [
    {
      role: "assistant",
      text: "checking",
      toolCalls: [{ id: "t1", name: "echo", input: { text: "x" } }],
      raw: { provider: "anthropic", data: [{ type: "thinking" }] },
    },
  ];
  assert.deepEqual(toResponsesInput(messages), [
    { role: "assistant", content: "checking" },
    { type: "function_call", call_id: "t1", name: "echo", arguments: '{"text":"x"}' },
  ]);
});

test("tool errors are marked in the output text", () => {
  const input = toResponsesInput([{ role: "tool", results: [{ callId: "c", name: "n", content: "bad", isError: true }] }]);
  assert.deepEqual(input, [{ type: "function_call_output", call_id: "c", output: "ERROR: bad" }]);
});
