import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AgentSession } from "../src/agent/session.js";
import { ToolRegistry, defineTool } from "../src/agent/tools.js";
import { Store } from "../src/state/store.js";
import type { LlmClient, LlmRequest, LlmResponse, ToolCall } from "../src/llm/types.js";

type Script = (req: LlmRequest, n: number) => { text?: string; calls?: ToolCall[]; throws?: boolean };

/** A model whose every answer is scripted by the test; it records each request. */
class ScriptedLlm implements LlmClient {
  readonly provider = "scripted";
  readonly model = "scripted";
  readonly requests: LlmRequest[] = [];
  constructor(
    private readonly script: Script,
    private readonly delayMs = 0,
  ) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    // Snapshot the request exactly as sent: deep copy, because the history keeps growing.
    this.requests.push(JSON.parse(JSON.stringify(req)));
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const out = this.script(req, this.requests.length - 1);
    if (out.throws) throw new Error("provider unavailable");
    const calls = out.calls ?? [];
    return {
      text: out.text ?? "",
      toolCalls: calls,
      stop: calls.length ? "tool_use" : "end",
      raw: { provider: "scripted", data: { n: this.requests.length } },
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 },
      model: "scripted",
    };
  }
}

const slowTool = defineTool({
  name: "slow",
  description: "waits",
  schema: z.object({ ms: z.number() }),
  run: async ({ ms }) => {
    await new Promise((r) => setTimeout(r, ms));
    return "slow done";
  },
});
const echoTool = defineTool({
  name: "echo",
  description: "echo",
  schema: z.object({ text: z.string() }),
  run: ({ text }) => text,
});

function session(llm: LlmClient, store = new Store(":memory:"), extra: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}) {
  if (!store.getSession("s1")) store.createSession({ id: "s1", role: "test", status: "idle" });
  return new AgentSession({
    id: "s1",
    role: "test",
    store,
    llm,
    tools: new ToolRegistry([slowTool, echoTool]),
    system: "frozen system prompt",
    maxSteps: 10,
    compactTokens: 1_000_000,
    ...extra,
  });
}

test("every request extends the previous one: history is append-only, system and tools frozen", async () => {
  let call = 0;
  const llm = new ScriptedLlm((req) => {
    call++;
    const last = req.messages[req.messages.length - 1];
    if (last.role === "user") return { calls: [{ id: `c${call}`, name: "echo", input: { text: "hi" } }] };
    return { text: "done" };
  });
  const s = session(llm);
  s.push("first");
  await s.idle();
  s.push("second");
  await s.idle();
  s.push("third");
  await s.idle();

  assert.ok(llm.requests.length >= 6);
  for (let i = 1; i < llm.requests.length; i++) {
    const prev = llm.requests[i - 1];
    const cur = llm.requests[i];
    assert.equal(cur.system, prev.system);
    assert.deepEqual(cur.tools, prev.tools);
    assert.deepEqual(cur.messages.slice(0, prev.messages.length), prev.messages, `request ${i} rewrote history`);
  }
});

test("input that arrives while the session is thinking is batched into one message", async () => {
  const llm = new ScriptedLlm(() => ({ text: "ok" }), 40);
  const s = session(llm);
  s.push("A");
  await new Promise((r) => setTimeout(r, 10)); // A is being processed
  s.push("B");
  s.push("C");
  await s.idle();
  assert.equal(llm.requests.length, 2);
  const second = llm.requests[1].messages;
  const lastUser = second[second.length - 1];
  assert.equal(lastUser.role, "user");
  assert.equal((lastUser as { content: string }).content, "B\n\nC");
});

test("full duplex: input during a slow tool is seen on the very next step", async () => {
  const llm = new ScriptedLlm((req, n) => (n === 0 ? { calls: [{ id: "t1", name: "slow", input: { ms: 60 } }] } : { text: "ok" }));
  const s = session(llm);
  s.push("start the slow thing");
  await new Promise((r) => setTimeout(r, 20)); // the tool is running
  s.push("new instruction");
  await s.idle();
  const msgs = llm.requests[1].messages;
  assert.equal(msgs[msgs.length - 2].role, "tool");
  assert.deepEqual(msgs[msgs.length - 1], { role: "user", content: "new instruction" });
  assert.equal(llm.requests.length, 2, "both inputs handled within one turn");
});

test("compaction starts a new epoch whose first message is the summary; old epochs stay stored", async () => {
  const store = new Store(":memory:");
  const llm = new ScriptedLlm((req) => {
    const last = req.messages[req.messages.length - 1] as { content?: string };
    return { text: last.content?.includes("compact summary") ? "SUMMARY: all quiet" : "ok" };
  });
  const s = session(llm, store, { compactTokens: 50 });
  s.push("hello");
  await s.idle();
  assert.equal(store.getSession("s1")!.epoch, 1);
  const epoch1 = store.loadMessages("s1", 1);
  assert.equal(epoch1.length, 1);
  assert.match((epoch1[0] as { content: string }).content, /SUMMARY: all quiet/);
  assert.ok(store.loadMessages("s1", 0).length >= 4);
});

test("a failed LLM call is retried with backoff and nothing is lost", async () => {
  const llm = new ScriptedLlm((_req, n) => (n === 0 ? { throws: true } : { text: "recovered" }));
  const s = session(llm, undefined, { retryBaseMs: 20 });
  s.push("important");
  await new Promise((r) => setTimeout(r, 120));
  await s.idle();
  assert.equal(llm.requests.length, 2);
  assert.deepEqual(llm.requests[1].messages, llm.requests[0].messages);
  assert.equal(s.status, "idle");
});

test("a new process resumes the same session from the store", async () => {
  const store = new Store(":memory:");
  const llm = new ScriptedLlm(() => ({ text: "ok" }));
  const s = session(llm, store);
  s.push("remember this");
  await s.idle();
  const resumed = session(new ScriptedLlm(() => ({ text: "ok" })), store);
  assert.deepEqual(resumed.messages(), s.messages());
});

test("invalid tool arguments go back to the model as an error, not a crash", async () => {
  const llm = new ScriptedLlm((_req, n) => (n === 0 ? { calls: [{ id: "x", name: "echo", input: { wrong: 1 } }] } : { text: "fixed" }));
  const s = session(llm);
  s.push("go");
  await s.idle();
  const tool = llm.requests[1].messages.find((m) => m.role === "tool") as { results: { isError?: boolean; content: string }[] };
  assert.equal(tool.results[0].isError, true);
  assert.match(tool.results[0].content, /Invalid arguments/);
});
