import type { Config, LlmRole } from "../config.js";
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse, ToolCall } from "./types.js";
import { estimateTokens } from "./types.js";

/**
 * A deterministic, scripted stand-in for a model (LLM_PROVIDER=mock). It plays
 * every role well enough to drive the whole architecture end to end without an
 * API key: tests use it, and it is a safe way to try the system offline. It
 * does not reason; it follows fixed rules over the structured blocks the
 * system renders.
 */
export class MockLlm implements LlmClient {
  readonly provider = "mock";
  readonly model = "mock";
  /** Every request this client received (tests inspect them). */
  readonly requests: LlmRequest[] = [];
  private seq = 0;

  constructor(
    readonly role: LlmRole,
    private readonly config: Pick<Config, "mode">,
    private readonly delayMs = 0,
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push({ ...request, messages: [...request.messages] });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const calls = this.decide(request);
    const text = calls.length ? "" : this.finalText(request);
    return {
      text,
      toolCalls: calls,
      stop: calls.length ? "tool_use" : "end",
      raw: { provider: "mock", data: null },
      usage: { inputTokens: estimateTokens(request.messages, request.system), outputTokens: 20, cacheReadTokens: 0 },
      model: this.model,
    };
  }

  private call(name: string, input: Record<string, unknown>): ToolCall {
    return { id: `mock_${this.role}_${++this.seq}`, name, input };
  }

  private finalText(request: LlmRequest): string {
    const last = lastUser(request.messages);
    if (last.includes("Write a compact summary")) return "Summary: mock session state; nothing pending.";
    return "";
  }

  private decide(request: LlmRequest): ToolCall[] {
    const last = request.messages[request.messages.length - 1];
    if (!last) return [];
    if (this.role === "filter") return this.filter(request);
    if (last.role === "tool") return this.role === "worker" ? this.workerAfterTools(request) : [];
    const text = last.role === "user" ? last.content : "";
    if (text.includes("Write a compact summary")) return [];
    if (this.role === "router") return this.router(text);
    if (this.role === "watchdog") return this.watchdog(text);
    return this.workerOnInput(request, text);
  }

  // ------------------------------------------------------------------ filter

  private filter(request: LlmRequest): ToolCall[] {
    const prompt = lastUser(request.messages);
    const decisions = blocks(prompt, "trigger").map((b) => {
      const scores = [...b.body.matchAll(/score=([0-9.]+)/g)].map((m) => Number(m[1]));
      const best = scores.length ? Math.max(...scores) : 0;
      const act = b.attrs.source === "market" ? best >= 0.6 : /\?/.test(b.body);
      return { id: b.attrs.id, act, reason: act ? `score ${best}` : `score ${best} below mock bar` };
    });
    return [this.call("decide", { decisions })];
  }

  // ------------------------------------------------------------------ router

  private router(text: string): ToolCall[] {
    const calls: ToolCall[] = [];
    for (const b of blocks(text, "trigger")) {
      const a = b.attrs;
      if (a.source === "market") {
        const [, symbol, timeframe] = a.thread.split(":");
        calls.push(
          this.call("dispatch_worker", {
            task: `Analyse the setup on ${symbol} ${timeframe} and act on it if it holds up.`,
            symbol,
            timeframe,
            threads: [],
            trigger_ids: [a.id],
          }),
        );
      } else if (a.source === "chat") {
        calls.push(this.call("reply", { channel: a.channel, ...(a.target ? { target: a.target } : {}), text: "Got it. On it." }));
      } else if (a.source === "worker") {
        const firstLine = b.body.split("\n")[0];
        if (/NEW SIGNAL|OPENED|digest/i.test(firstLine)) {
          calls.push(this.call("notify", { text: firstLine.replace(/^wrk_[a-z0-9]+( \(finished\))?: /, "").slice(0, 500).split(/\s+/).slice(0, 90).join(" ") }));
        } else {
          calls.push(this.call("ignore", { trigger_ids: [a.id], reason: "progress update" }));
        }
      } else if (a.source === "schedule") {
        calls.push(this.call("dispatch_worker", { task: "Compile the daily digest for the owner and report it.", trigger_ids: [a.id] }));
      } else if (a.source === "broker") {
        calls.push(this.call("dispatch_worker", { task: "Take over and manage this paper position.", threads: [a.thread], trigger_ids: [a.id] }));
      } else {
        calls.push(this.call("ignore", { trigger_ids: [a.id], reason: "no action needed" }));
      }
    }
    return calls;
  }

  // ---------------------------------------------------------------- watchdog

  private watchdog(text: string): ToolCall[] {
    const chat = blocks(text, "trigger").find((b) => b.attrs.source === "chat");
    if (chat) {
      return [
        this.call("reply", {
          channel: chat.attrs.channel,
          ...(chat.attrs.target ? { target: chat.attrs.target } : {}),
          text: "Watchdog: systems checked.",
        }),
      ];
    }
    return [];
  }

  // ------------------------------------------------------------------ worker

  private workerOnInput(request: LlmRequest, text: string): ToolCall[] {
    const task = taskOf(request.messages);
    if (text.includes("nothing will wake you")) return [this.call("finish", { summary: "Done." })];
    if (text.startsWith("<task")) {
      if (/digest/i.test(task.text)) return [this.call("scorecard", { days: 1 }), this.call("activity", { hours: 24 })];
      if (!task.symbol || !task.timeframe) return [this.call("finish", { summary: "Nothing to analyse." })];
      return [this.call("market_snapshot", { symbol: task.symbol, timeframe: task.timeframe })];
    }
    // An event on a subscribed thread: a closed position ends the task.
    for (const b of blocks(text, "trigger")) {
      if (["stop_hit", "target_hit", "closed"].includes(b.attrs.kind)) {
        return [this.call("finish", { summary: `Position closed: ${b.body.split("\n")[0]}` })];
      }
    }
    return [];
  }

  private workerAfterTools(request: LlmRequest): ToolCall[] {
    const last = request.messages[request.messages.length - 1] as Extract<ChatMessage, { role: "tool" }>;
    const task = taskOf(request.messages);
    const speculative = request.system.includes("pre-analysis worker");
    const byName = Object.fromEntries(last.results.map((r) => [r.name, r]));

    if (byName.scorecard || byName.activity) {
      return [this.call("finish", { summary: `Daily digest: ${byName.scorecard?.content.slice(0, 300) ?? ""}` })];
    }
    if (byName.market_snapshot) {
      if (speculative) return [this.call("finish", { summary: `Pre-analysis ready for ${task.symbol} ${task.timeframe}.` })];
      let snap: { setups?: { side: string; entry: number; stop: number; target: number; score: number; detector: string; reason: string }[] } = {};
      try {
        snap = JSON.parse(byName.market_snapshot.content);
      } catch {
        return [this.call("finish", { summary: "Could not read the snapshot." })];
      }
      const best = (snap.setups ?? []).sort((a, b) => b.score - a.score)[0];
      if (!best) return [this.call("finish", { summary: "No trade: the setup is gone on the latest candle." })];
      const rationale = `${best.detector}: ${best.reason}`;
      if (this.config.mode === "signals") {
        return [
          this.call("propose_signal", {
            symbol: task.symbol,
            timeframe: task.timeframe,
            side: best.side,
            entry: best.entry,
            stop: best.stop,
            target: best.target,
            confidence: best.score,
            rationale,
          }),
        ];
      }
      return [
        this.call("place_paper_order", {
          symbol: task.symbol,
          side: best.side,
          stop: best.stop,
          target: best.target,
          timeframe: task.timeframe,
          rationale,
        }),
      ];
    }
    if (byName.propose_signal) return [this.call("finish", { summary: "Signal recorded." })];
    if (byName.place_paper_order) {
      if (byName.place_paper_order.content.startsWith("REJECTED")) {
        return [this.call("finish", { summary: byName.place_paper_order.content })];
      }
      return []; // hold the position and wait for its events
    }
    return [];
  }
}

function lastUser(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return m.content;
  }
  return "";
}

function taskOf(messages: ChatMessage[]): { text: string; symbol?: string; timeframe?: string } {
  const first = messages.find((m): m is Extract<ChatMessage, { role: "user" }> => m.role === "user" && m.content.startsWith("<task"));
  const content = first?.content ?? "";
  const text = /<task[^>]*>([\s\S]*?)<\/task>/.exec(content)?.[1] ?? "";
  const scope = /Symbol: ([A-Z0-9]+)(?:, timeframe: ([0-9]+[mhdw]))?/.exec(content);
  return { text, symbol: scope?.[1], timeframe: scope?.[2] };
}

interface Block {
  attrs: Record<string, string>;
  body: string;
}

/** Parse `<tag k=v ...>body</tag>` blocks rendered by context/render.ts. */
export function blocks(text: string, tag: string): Block[] {
  const out: Block[] = [];
  const re = new RegExp(`<${tag} ([^>]*)>\\n?([\\s\\S]*?)\\n?</${tag}>`, "g");
  for (const m of text.matchAll(re)) {
    const attrs: Record<string, string> = {};
    for (const kv of m[1].split(/\s+/)) {
      const i = kv.indexOf("=");
      if (i > 0) attrs[kv.slice(0, i)] = kv.slice(i + 1);
    }
    out.push({ attrs, body: m[2] });
  }
  return out;
}
