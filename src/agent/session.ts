import type { ChatMessage, LlmClient, LlmUsage, ToolResult } from "../llm/types.js";
import { estimateTokens } from "../llm/types.js";
import type { Store } from "../state/store.js";
import type { Semaphore } from "../util/semaphore.js";
import type { ToolRegistry } from "./tools.js";
import { logger } from "../util/log.js";

const log = logger("session");

export type SessionStatus = "idle" | "running" | "done" | "stopped" | "error";

export type SessionEvent =
  | { type: "turn_end"; sessionId: string; text: string; steps: number; usage?: LlmUsage }
  | { type: "llm_error"; sessionId: string; error: string; consecutive: number }
  | { type: "refusal"; sessionId: string }
  | { type: "compacted"; sessionId: string; epoch: number };

export interface SessionOptions {
  id: string;
  role: string;
  store: Store;
  llm: LlmClient;
  tools: ToolRegistry;
  /** Frozen for the session's lifetime: changing it would break cache and replay. */
  system: string;
  maxSteps: number;
  compactTokens: number;
  semaphore?: Semaphore;
  onEvent?: (event: SessionEvent) => void;
  /** First retry delay after a failed LLM call; doubles per consecutive failure. */
  retryBaseMs?: number;
}

const COMPACT_PROMPT =
  "Your context is getting long. Write a compact summary that lets you continue seamlessly: open tasks, " +
  "workers and what each is doing, open positions and signals with their ids, decisions made and why, " +
  "owner preferences, and anything you promised to do. Use ids (wrk_, sig_, pos_, trg_, pol_) so you can " +
  "recall details later. Reply with the summary only and do not call any tools.";

const MAX_BACKOFF_MS = 120_000;

/**
 * One LLM session: an append-only history, an inbox, and a tool loop.
 *
 * - Events are pushed into the inbox at any time. When the session is idle
 *   they start a turn; when it is mid-turn they are appended right after the
 *   current tool step, so new input is seen as soon as the step ends.
 * - The history is only ever appended to. When it grows past
 *   `compactTokens`, the session writes a summary and starts a new epoch
 *   whose first message is that summary; older epochs stay in the store.
 */
export class AgentSession {
  readonly id: string;
  readonly role: string;
  private history: ChatMessage[];
  private epoch: number;
  private inbox: string[] = [];
  private running = false;
  private needsTurn = false;
  private consecutiveErrors = 0;
  private retryTimer?: NodeJS.Timeout;
  private idleWaiters: (() => void)[] = [];
  private _status: SessionStatus = "idle";
  lastUsage?: LlmUsage;

  constructor(private readonly opts: SessionOptions) {
    this.id = opts.id;
    this.role = opts.role;
    const row = opts.store.getSession(opts.id);
    this.epoch = row?.epoch ?? 0;
    this.history = opts.store.loadMessages(opts.id, this.epoch);
    // A resumed session whose last message is unanswered input picks up where it left off.
    const last = this.history[this.history.length - 1];
    if (last && last.role !== "assistant") this.needsTurn = true;
  }

  get status(): SessionStatus {
    return this._status;
  }

  get finished(): boolean {
    return this._status === "done" || this._status === "stopped";
  }

  get busy(): boolean {
    return this.running;
  }

  get pending(): number {
    return this.inbox.length;
  }

  messages(): readonly ChatMessage[] {
    return this.history;
  }

  push(text: string): void {
    if (this.finished) return;
    this.inbox.push(text);
    this.kick();
  }

  /** Start a turn for a resumed session that has unanswered input. */
  resume(): void {
    if (this.needsTurn) this.kick();
  }

  /** Mark the session finished. A running turn ends after its current step. */
  finish(status: "done" | "stopped"): void {
    this._status = status;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.opts.store.updateSession(this.id, { status });
    this.notifyIdle();
  }

  /** Resolves once the session has nothing running and nothing queued. */
  idle(): Promise<void> {
    if (!this.running && this.inbox.length === 0 && !this.needsTurn) return Promise.resolve();
    if (this.finished && !this.running) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private kick(): void {
    if (this.running || this.finished) return;
    void this.loop();
  }

  private async loop(): Promise<void> {
    this.running = true;
    this.setStatus("running");
    try {
      while (!this.finished && (this.inbox.length > 0 || this.needsTurn)) {
        if (this.retryTimer && this.inbox.length === 0) break; // waiting out a backoff
        const release = this.opts.semaphore ? await this.opts.semaphore.acquire() : () => {};
        try {
          if (this.inbox.length) this.append({ role: "user", content: this.inbox.splice(0).join("\n\n") });
          this.needsTurn = false;
          await this.turn();
          if (!this.finished) await this.maybeCompact();
        } finally {
          release();
        }
      }
    } finally {
      this.running = false;
      if (!this.finished) this.setStatus(this.consecutiveErrors > 0 ? "error" : "idle");
      this.notifyIdle();
    }
  }

  private async turn(): Promise<void> {
    let lastText = "";
    let steps = 0;
    for (; steps < this.opts.maxSteps; steps++) {
      let response;
      try {
        response = await this.opts.llm.complete({
          system: this.opts.system,
          messages: this.history,
          tools: this.opts.tools.specs(),
        });
      } catch (err) {
        this.onLlmError(err as Error);
        return;
      }
      this.consecutiveErrors = 0;
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
      }
      this.lastUsage = response.usage;
      this.append({ role: "assistant", text: response.text, toolCalls: response.toolCalls, raw: response.raw });
      if (response.text) lastText = response.text;

      if (response.stop === "refusal") {
        log.warn(`${this.id}: model declined the request`);
        this.opts.onEvent?.({ type: "refusal", sessionId: this.id });
      }
      if (response.toolCalls.length === 0) break;

      const results: ToolResult[] = await Promise.all(
        response.toolCalls.map((call) => this.opts.tools.execute(call, { sessionId: this.id, role: this.role })),
      );
      this.append({ role: "tool", results });
      this.opts.store.updateSession(this.id, { progress: true });

      if (this.finished) break;
      // Full duplex: input that arrived during this step is seen on the next one.
      if (this.inbox.length) this.append({ role: "user", content: this.inbox.splice(0).join("\n\n") });
    }
    if (steps >= this.opts.maxSteps) log.warn(`${this.id}: stopped after ${steps} tool steps this turn`);
    this.opts.store.updateSession(this.id, { progress: true });
    this.opts.onEvent?.({ type: "turn_end", sessionId: this.id, text: lastText, steps, usage: this.lastUsage });
  }

  private onLlmError(err: Error): void {
    this.consecutiveErrors++;
    const delay = Math.min(MAX_BACKOFF_MS, (this.opts.retryBaseMs ?? 5_000) * 2 ** (this.consecutiveErrors - 1));
    log.error(`${this.id}: LLM call failed (${this.consecutiveErrors} in a row), retrying in ${delay / 1000}s`, err);
    this.opts.store.updateSession(this.id, { error: true });
    this.opts.onEvent?.({ type: "llm_error", sessionId: this.id, error: err.message, consecutive: this.consecutiveErrors });
    this.needsTurn = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.kick();
    }, delay);
    this.retryTimer.unref?.();
  }

  private async maybeCompact(): Promise<void> {
    const used = this.lastUsage?.inputTokens || estimateTokens(this.history, this.opts.system);
    if (used < this.opts.compactTokens) return;
    this.append({ role: "user", content: COMPACT_PROMPT });
    let summary = "";
    try {
      const response = await this.opts.llm.complete({
        system: this.opts.system,
        messages: this.history,
        tools: this.opts.tools.specs(),
      });
      this.append({ role: "assistant", text: response.text, toolCalls: [], raw: response.raw });
      summary = response.text.trim();
    } catch (err) {
      log.error(`${this.id}: compaction call failed, keeping the current epoch`, err);
      return;
    }
    if (!summary) {
      log.warn(`${this.id}: empty compaction summary, keeping the current epoch`);
      return;
    }
    this.epoch += 1;
    this.opts.store.updateSession(this.id, { epoch: this.epoch });
    this.history = [];
    this.append({
      role: "user",
      content:
        `Summary of your earlier context (you wrote it before a context reset):\n${summary}\n\n` +
        "Everything else is in the object store; use recall(id) to read any object you need.",
    });
    log.info(`${this.id}: compacted into epoch ${this.epoch}`);
    this.opts.onEvent?.({ type: "compacted", sessionId: this.id, epoch: this.epoch });
  }

  private append(message: ChatMessage): void {
    this.history.push(message);
    this.opts.store.appendMessage(this.id, this.epoch, message);
  }

  private setStatus(status: SessionStatus): void {
    if (this.finished) return;
    this._status = status;
    this.opts.store.updateSession(this.id, { status });
  }

  private notifyIdle(): void {
    if (this.running || (this.inbox.length > 0 && !this.finished)) return;
    if (this.needsTurn && !this.finished && !this.retryTimer) return;
    const waiters = this.idleWaiters.splice(0);
    for (const w of waiters) w();
  }
}
