import { createHash } from "node:crypto";
import { AgentSession } from "../agent/session.js";
import type { Trigger } from "../events/trigger.js";
import { renderTrigger } from "../context/render.js";
import type { Runtime } from "../runtime.js";
import { routerSystemPrompt } from "./prompt.js";
import { buildRouterTools } from "./tools.js";
import { logger } from "../util/log.js";

const log = logger("router");

export const ROUTER_ID = "router";
const MAX_FYI = 30;

/**
 * The Router (design §2.1): one long-lived session. Triggers pushed while it
 * is thinking are merged into its next call (batching); FYI lines for events
 * that workers already own ride along with the next real batch.
 */
export class Router {
  session!: AgentSession;
  private fyiBuffer: string[] = [];

  constructor(private readonly rt: Runtime) {}

  start(): void {
    const { store, config } = this.rt;
    const system = routerSystemPrompt(config);
    const hash = createHash("sha256").update(system).digest("hex").slice(0, 16);
    const llm = this.rt.llm("router");
    const existing = store.getSession(ROUTER_ID);
    if (!existing) {
      store.createSession({ id: ROUTER_ID, role: "router", status: "idle", model: llm.model, meta: { systemHash: hash } });
    } else if (existing.meta.systemHash !== hash) {
      // The frozen system prompt changed (new mode, symbols...): start a fresh epoch
      // rather than editing a conversation the old prompt produced.
      store.updateSession(ROUTER_ID, { epoch: existing.epoch + 1, meta: { systemHash: hash } });
      log.info("configuration changed; router starts a new epoch");
    }
    this.session = new AgentSession({
      id: ROUTER_ID,
      role: "router",
      store,
      llm,
      tools: buildRouterTools(this.rt),
      system,
      maxSteps: config.maxToolStepsPerTurn,
      compactTokens: config.routerCompactTokens,
      onEvent: (e) => this.rt.onSessionEvent(e),
    });
    this.session.resume();
  }

  /** A trigger that needs a decision. */
  submit(t: Trigger): void {
    const parts = this.fyiBuffer.splice(0);
    parts.push(renderTrigger(t, this.rt.store));
    this.rt.store.setTriggerStatus(t.id, "routed");
    this.session.push(parts.join("\n"));
  }

  /** An event a worker already owns: the Router sees it, but it does not cost a call on its own. */
  fyi(t: Trigger): void {
    this.fyiBuffer.push(renderTrigger(t, this.rt.store, { fyi: true }));
    if (this.fyiBuffer.length > MAX_FYI) this.fyiBuffer.splice(0, this.fyiBuffer.length - MAX_FYI);
  }

  /** Free-form note from the system (not from an event source). */
  note(text: string): void {
    this.session.push(`<system-note>${text}</system-note>`);
  }
}
