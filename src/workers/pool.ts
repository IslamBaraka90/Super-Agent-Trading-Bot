import { AgentSession, type SessionEvent } from "../agent/session.js";
import type { Timeframe } from "../config.js";
import type { Trigger } from "../events/trigger.js";
import { renderTrigger } from "../context/render.js";
import type { Runtime } from "../runtime.js";
import { newId } from "../util/ids.js";
import { oneLine } from "../util/text.js";
import { Semaphore } from "../util/semaphore.js";
import { logger } from "../util/log.js";
import { buildWorkerTools, describeTask, makeReportTrigger, validThread, type WorkerKind } from "./tools.js";
import { speculativeSystemPrompt, workerSystemPrompt } from "./prompt.js";

const log = logger("workers");

export interface DispatchRequest {
  task: string;
  symbol?: string;
  timeframe?: Timeframe;
  threads: string[];
  triggerIds: string[];
  kind: WorkerKind;
}

export interface WorkerInfo {
  id: string;
  kind: string;
  status: string;
  task: string;
  threads: string[];
  idleMinutes: number;
}

const ACTIVE = ["idle", "running", "error"];

/**
 * The Worker layer (design §2.2): one isolated session per task. A semaphore
 * caps how many worker turns run at once; a worker waiting for events holds
 * no slot.
 */
export class WorkerPool {
  readonly semaphore: Semaphore;
  private sessions = new Map<string, AgentSession>();
  private nudged = new Set<string>();

  constructor(private readonly rt: Runtime) {
    this.semaphore = new Semaphore(rt.config.maxWorkers);
  }

  dispatch(req: DispatchRequest): string {
    const { store, threads } = this.rt;
    const id = newId("wrk");
    const llm = this.rt.llm("worker");
    const task = describeTask(req);
    store.createSession({
      id,
      role: "worker",
      status: "idle",
      task,
      model: llm.model,
      meta: { kind: req.kind, symbol: req.symbol ?? null, timeframe: req.timeframe ?? null },
    });
    const validThreads = req.threads.filter((t) => !validThread(this.rt, t));
    store.putObject({
      id,
      kind: "worker",
      summary: `${req.kind === "speculative" ? "pre-analysis: " : ""}${oneLine(task, 160)}`,
      body: { task: req.task, kind: req.kind, symbol: req.symbol ?? null, timeframe: req.timeframe ?? null },
      links: [...validThreads, ...req.triggerIds],
      status: "running",
    });
    for (const t of validThreads) threads.subscribe(t, id);

    const session = this.create(id, req.kind);
    const triggers = req.triggerIds
      .map((tid) => store.getObject(tid))
      .filter((o) => o?.kind === "trigger")
      .map((o) => renderTrigger(o!.body as unknown as Trigger, store));
    const ignored = req.threads.filter((t) => validThread(this.rt, t));
    session.push(
      [
        `<task id=${id}>${req.task}</task>`,
        req.symbol ? `Symbol: ${req.symbol}${req.timeframe ? `, timeframe: ${req.timeframe}` : ""}.` : "",
        validThreads.length ? `You are subscribed to: ${validThreads.join(", ")}.` : "You have no subscriptions yet.",
        ignored.length ? `Ignored invalid thread keys: ${ignored.join(", ")}.` : "",
        ...triggers,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    log.info(`dispatched ${id}: ${oneLine(task, 100)}`);
    return id;
  }

  private create(id: string, kind: WorkerKind): AgentSession {
    const session = new AgentSession({
      id,
      role: "worker",
      store: this.rt.store,
      llm: this.rt.llm("worker"),
      tools: buildWorkerTools(this.rt, id, kind),
      system: kind === "speculative" ? speculativeSystemPrompt() : workerSystemPrompt(this.rt.config),
      maxSteps: this.rt.config.maxToolStepsPerTurn,
      compactTokens: this.rt.config.workerCompactTokens,
      semaphore: this.semaphore,
      onEvent: (e) => this.onEvent(id, e),
    });
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  deliver(id: string, t: Trigger): boolean {
    const session = this.sessions.get(id);
    if (!session || session.finished) return false;
    session.push(renderTrigger(t, this.rt.store));
    return true;
  }

  message(id: string, text: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.finished) return false;
    session.push(`<router-message>${text}</router-message>`);
    return true;
  }

  report(id: string, text: string, final: boolean, links: string[] = []): void {
    const kind = (this.rt.store.getSession(id)?.meta.kind as string | undefined) ?? "task";
    if (kind === "speculative") return;
    this.rt.ingest(makeReportTrigger(id, text, final, links));
  }

  /** Called by the finish tool. */
  complete(id: string, summary: string, kind: WorkerKind): void {
    const session = this.sessions.get(id);
    this.rt.threads.unsubscribeAll(id);
    this.rt.store.updateObject(id, { status: "done", body: { result: summary } });
    session?.finish("done");
    if (kind === "speculative") this.rt.speculator.onResult(id, summary);
    else this.report(id, summary, true);
    log.info(`${id} finished`);
  }

  stop(id: string, reason: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.finished) return false;
    session.finish("stopped");
    this.rt.threads.unsubscribeAll(id);
    this.rt.store.updateObject(id, { status: "stopped", body: { stopReason: reason } });
    log.info(`${id} stopped: ${reason}`);
    return true;
  }

  list(includeFinishedMinutes: number): WorkerInfo[] {
    const now = Date.now();
    return this.rt.store
      .listSessions({ role: "worker" })
      .filter(
        (s) =>
          ACTIVE.includes(s.status) ||
          (includeFinishedMinutes > 0 && now - s.updatedAt <= includeFinishedMinutes * 60_000),
      )
      .map((s) => ({
        id: s.id,
        kind: String(s.meta.kind ?? "task"),
        status: s.status,
        task: oneLine(s.task ?? "", 140),
        threads: this.rt.threads.threadsOf(s.id),
        idleMinutes: Math.round((now - s.lastProgressAt) / 60_000),
      }));
  }

  /** True while any worker is mid-turn or has queued input. */
  get busy(): boolean {
    return [...this.sessions.values()].some((s) => !s.finished && (s.busy || s.pending > 0));
  }

  activeSpeculative(): number {
    return [...this.sessions.entries()].filter(
      ([id, s]) => !s.finished && this.rt.store.getSession(id)?.meta.kind === "speculative",
    ).length;
  }

  /** Restart: rebuild every unfinished worker from the store and let it continue. */
  resumeAll(): number {
    let resumed = 0;
    for (const row of this.rt.store.listSessions({ role: "worker", status: ACTIVE })) {
      if (row.meta.kind === "speculative") {
        // Pre-analysis is only useful for the candle it was made for.
        this.rt.store.updateSession(row.id, { status: "stopped" });
        this.rt.store.updateObject(row.id, { status: "stopped" });
        this.rt.threads.unsubscribeAll(row.id);
        continue;
      }
      const session = this.create(row.id, "task");
      session.push("<system-note>The agent process restarted. Your history and subscriptions are intact; continue your task.</system-note>");
      resumed++;
    }
    return resumed;
  }

  private onEvent(id: string, e: SessionEvent): void {
    this.rt.onSessionEvent(e);
    if (e.type === "turn_end") this.afterTurn(id);
  }

  /**
   * A worker whose turn ended without finishing, without subscriptions and
   * without running jobs would never wake again. Nudge it once, then end it.
   */
  private afterTurn(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.finished || session.pending > 0) return;
    const subs = this.rt.threads.threadsOf(id);
    const waiting = subs.some((t) => {
      if (!t.startsWith("job:")) return true;
      return this.rt.store.getJob(t.slice(4))?.status === "running";
    });
    if (waiting) return;
    if (!this.nudged.has(id)) {
      this.nudged.add(id);
      session.push(
        "<system-note>Your turn ended, but you own no event streams and have no running jobs, so nothing will wake you. " +
          "If your task is complete, call finish with a summary. Otherwise continue now.</system-note>",
      );
      return;
    }
    const kind = (this.rt.store.getSession(id)?.meta.kind as WorkerKind | undefined) ?? "task";
    log.warn(`${id} ended twice without finish; closing it`);
    this.complete(id, "Worker ended without calling finish; no final summary.", kind);
  }
}
