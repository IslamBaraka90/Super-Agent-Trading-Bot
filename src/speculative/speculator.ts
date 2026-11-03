import type { Timeframe } from "../config.js";
import type { Trigger } from "../events/trigger.js";
import type { NearSetup } from "../market/detectors.js";
import type { Candle } from "../market/types.js";
import { TF_MS, marketThread } from "../market/types.js";
import type { Runtime } from "../runtime.js";
import { newId } from "../util/ids.js";
import { logger } from "../util/log.js";

const log = logger("speculative");

interface Pending {
  spcId: string;
  workerId: string;
  expiresAt: number;
}

/**
 * Acting ahead (design §3.4). When a detector reports a near-setup, a silent
 * worker prepares the analysis before the candle closes. If the setup
 * confirms, the analysis is inlined into the trigger; if not, it is discarded
 * and nobody hears about it.
 */
export class Speculator {
  private pending = new Map<string, Pending>();

  constructor(private readonly rt: Runtime) {}

  onNear(symbol: string, timeframe: Timeframe, near: NearSetup[], candle: Candle, now = Date.now()): string | undefined {
    const { config } = this.rt;
    if (!config.speculative || near.length === 0) return undefined;
    const thread = marketThread(symbol, timeframe);
    const existing = this.pending.get(thread);
    if (existing && existing.expiresAt > now) return undefined;
    if (this.rt.threads.subscribers(thread).length > 0) return undefined;
    if (this.rt.pool.activeSpeculative() >= config.maxSpeculative) return undefined;

    const best = [...near].sort((a, b) => a.distanceAtr - b.distanceAtr)[0];
    const spcId = newId("spc");
    const workerId = this.rt.pool.dispatch({
      task:
        `Pre-analyse ${symbol} ${timeframe}: a ${best.detector} ${best.side} setup may trigger at the next close ` +
        `(${best.reason}; level ${Number(best.level.toPrecision(6))}).`,
      symbol,
      timeframe,
      threads: [],
      triggerIds: [],
      kind: "speculative",
    });
    this.rt.store.putObject({
      id: spcId,
      kind: "pre_analysis",
      summary: `pre-analysis ${symbol} ${timeframe} ${best.detector} ${best.side}`,
      body: { symbol, timeframe, detector: best.detector, side: best.side, workerId, text: "" },
      links: [workerId, thread],
      status: "preparing",
    });
    this.pending.set(thread, { spcId, workerId, expiresAt: candle.closeTime + 2 * TF_MS[timeframe] });
    log.info(`started ${spcId} for ${thread}`);
    return spcId;
  }

  onResult(workerId: string, summary: string): void {
    for (const p of this.pending.values()) {
      if (p.workerId !== workerId) continue;
      this.rt.store.updateObject(p.spcId, { status: "ready", body: { text: summary } });
    }
  }

  /** Inline a ready pre-analysis into the confirming market trigger. */
  attach(t: Trigger, now = Date.now()): void {
    const setups = (t.payload.setups as unknown[] | undefined) ?? [];
    if (t.source !== "market" || setups.length === 0) return;
    const p = this.pending.get(t.threadKey);
    if (!p || p.expiresAt <= now) return;
    const obj = this.rt.store.getObject<{ text: string }>(p.spcId);
    t.links = [...(t.links ?? []), p.spcId];
    if (obj?.status === "ready" && obj.body.text) {
      t.payload.preAnalysis = obj.body.text;
      this.rt.store.updateObject(p.spcId, { status: "delivered" });
      this.pending.delete(t.threadKey);
      log.info(`${p.spcId} delivered with ${t.id}`);
    }
  }

  /** Discard pre-analyses whose candle has passed without a confirming setup. */
  sweep(now = Date.now()): void {
    for (const [thread, p] of this.pending) {
      if (p.expiresAt > now) continue;
      this.pending.delete(thread);
      this.rt.pool.stop(p.workerId, "pre-analysis expired");
      const obj = this.rt.store.getObject(p.spcId);
      if (obj && obj.status !== "delivered") this.rt.store.updateObject(p.spcId, { status: "discarded" });
    }
  }
}
