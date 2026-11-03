import type { Store, StoredObject } from "../state/store.js";
import { makeTrigger, type Trigger } from "../events/trigger.js";
import type { Candle, Side } from "../market/types.js";
import { marketThread } from "../market/types.js";
import { newId } from "../util/ids.js";
import { fmtPrice, oneLine } from "../util/text.js";

export interface SignalBody {
  symbol: string;
  timeframe: string;
  side: Side;
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  rationale: string;
  workerId: string;
  expiresAt: number;
  triggerId: string | null;
  outcome: { result: "target_hit" | "stop_hit" | "expired"; exit: number; r: number; at: number } | null;
}

export interface Scorecard {
  created: number;
  resolved: number;
  open: number;
  wins: number;
  losses: number;
  expired: number;
  winRate: number;
  avgR: number;
  totalR: number;
}

/**
 * Signals and their scorecard (design §7.3). Every signal is checked against
 * the candles that close after it was issued and resolves as target_hit,
 * stop_hit (checked first when one candle touches both) or expired.
 */
export class SignalBook {
  constructor(
    private readonly store: Store,
    private readonly emit: (t: Trigger) => void,
  ) {}

  create(input: {
    symbol: string;
    timeframe: string;
    side: Side;
    entry: number;
    stop: number;
    target: number;
    confidence: number;
    rationale: string;
    workerId: string;
    expiresAt: number;
    trigger_id?: string;
  }): StoredObject<SignalBody> {
    const id = newId("sig");
    const body: SignalBody = {
      symbol: input.symbol,
      timeframe: input.timeframe,
      side: input.side,
      entry: input.entry,
      stop: input.stop,
      target: input.target,
      confidence: input.confidence,
      rationale: input.rationale,
      workerId: input.workerId,
      expiresAt: input.expiresAt,
      triggerId: input.trigger_id ?? null,
      outcome: null,
    };
    return this.store.putObject({
      id,
      kind: "signal",
      summary: `${input.side} ${input.symbol} ${input.timeframe} entry ${fmtPrice(input.entry)} stop ${fmtPrice(input.stop)} target ${fmtPrice(input.target)} (${Math.round(input.confidence * 100)}%)`,
      body,
      links: [input.workerId, marketThread(input.symbol, input.timeframe), ...(input.trigger_id ? [input.trigger_id] : [])],
      status: "open",
    });
  }

  open(): StoredObject<SignalBody>[] {
    return this.store.listObjects<SignalBody>("signal", { status: "open" });
  }

  /** Feed every closed candle of a polled timeframe through the open signals. */
  onCandle(symbol: string, timeframe: string, candle: Candle): void {
    for (const sig of this.open()) {
      const s = sig.body;
      if (s.symbol !== symbol || s.timeframe !== timeframe || candle.openTime < sig.createdAt) continue;
      const stopHit = s.side === "long" ? candle.low <= s.stop : candle.high >= s.stop;
      const targetHit = s.side === "long" ? candle.high >= s.target : candle.low <= s.target;
      if (stopHit) this.resolve(sig, "stop_hit", s.stop, candle.closeTime);
      else if (targetHit) this.resolve(sig, "target_hit", s.target, candle.closeTime);
      else if (candle.closeTime >= s.expiresAt) this.resolve(sig, "expired", candle.close, candle.closeTime);
    }
  }

  private resolve(sig: StoredObject<SignalBody>, result: "target_hit" | "stop_hit" | "expired", exit: number, at: number): void {
    const s = sig.body;
    const risk = Math.abs(s.entry - s.stop);
    const r = risk > 0 ? (s.side === "long" ? exit - s.entry : s.entry - exit) / risk : 0;
    this.store.updateObject<SignalBody>(sig.id, { status: result, body: { outcome: { result, exit, r, at } } });
    this.emit(
      makeTrigger({
        source: "system",
        kind: "signal_resolved",
        threadKey: `sig:${sig.id}`,
        summary: `${sig.id} ${s.side} ${s.symbol} ${s.timeframe}: ${result.replace("_", " ")} at ${fmtPrice(exit)} (${r.toFixed(2)}R)`,
        payload: { signalId: sig.id, result, exit, r: Number(r.toFixed(3)), rationale: oneLine(s.rationale, 120) },
        links: [sig.id],
        dedupeKey: `sig-resolved:${sig.id}`,
      }),
    );
  }

  scorecard(since: number): Scorecard {
    const signals = this.store.listObjects<SignalBody>("signal", { limit: 5_000 }).filter((s) => s.createdAt >= since);
    const resolved = signals.filter((s) => s.body.outcome);
    const rs = resolved.map((s) => s.body.outcome!.r);
    const totalR = rs.reduce((a, b) => a + b, 0);
    const wins = rs.filter((r) => r > 0).length;
    return {
      created: signals.length,
      resolved: resolved.length,
      open: signals.length - resolved.length,
      wins,
      losses: rs.filter((r) => r <= 0).length,
      expired: resolved.filter((s) => s.body.outcome!.result === "expired").length,
      winRate: resolved.length ? wins / resolved.length : 0,
      avgR: resolved.length ? totalR / resolved.length : 0,
      totalR,
    };
  }
}
