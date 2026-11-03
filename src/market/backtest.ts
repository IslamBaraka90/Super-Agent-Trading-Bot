import { computeSeries, detectAt, MIN_BARS, type DetectorName } from "./detectors.js";
import type { Candle, Side } from "./types.js";

export interface BacktestTrade {
  side: Side;
  entryTime: number;
  exitTime: number;
  entry: number;
  exit: number;
  r: number;
  outcome: "target" | "stop" | "timeout";
}

export interface BacktestResult {
  detector: string;
  bars: number;
  trades: number;
  wins: number;
  winRate: number;
  avgR: number;
  totalR: number;
  maxDrawdownR: number;
  byOutcome: Record<string, number>;
  sample: BacktestTrade[];
}

/**
 * Walk-forward replay of one detector: enter at the signal bar's close, exit at
 * stop or target (stop assumed first when one bar touches both), or after
 * `maxHoldBars`. One position at a time. Costs are not modelled; the result is
 * a sanity check on the setup, not a performance claim.
 */
export function backtestDetector(
  candles: Candle[],
  detector: DetectorName | "all",
  opts: { targetR: number; maxHoldBars?: number; side?: Side; signal?: AbortSignal },
): BacktestResult {
  const maxHold = opts.maxHoldBars ?? 50;
  const series = computeSeries(candles);
  const trades: BacktestTrade[] = [];
  let i = MIN_BARS - 1;
  while (i < candles.length - 1) {
    if (opts.signal?.aborted) throw new Error("backtest cancelled");
    const { setups } = detectAt(series, i, { targetR: opts.targetR, nearAtr: 0 });
    const setup = setups
      .filter((s) => (detector === "all" || s.detector === detector) && (!opts.side || s.side === opts.side))
      .sort((a, b) => b.score - a.score)[0];
    if (!setup) {
      i++;
      continue;
    }
    const risk = Math.abs(setup.entry - setup.stop);
    let exit = NaN;
    let exitIndex = -1;
    let outcome: BacktestTrade["outcome"] = "timeout";
    for (let j = i + 1; j < candles.length && j <= i + maxHold; j++) {
      const c = candles[j];
      const stopHit = setup.side === "long" ? c.low <= setup.stop : c.high >= setup.stop;
      const targetHit = setup.side === "long" ? c.high >= setup.target : c.low <= setup.target;
      if (stopHit) {
        const gapped = setup.side === "long" ? c.open < setup.stop : c.open > setup.stop;
        exit = gapped ? c.open : setup.stop;
        outcome = "stop";
        exitIndex = j;
        break;
      }
      if (targetHit) {
        exit = setup.target;
        outcome = "target";
        exitIndex = j;
        break;
      }
    }
    if (exitIndex === -1) {
      exitIndex = Math.min(candles.length - 1, i + maxHold);
      exit = candles[exitIndex].close;
    }
    const pnl = setup.side === "long" ? exit - setup.entry : setup.entry - exit;
    trades.push({
      side: setup.side,
      entryTime: candles[i].closeTime,
      exitTime: candles[exitIndex].closeTime,
      entry: setup.entry,
      exit,
      r: risk > 0 ? pnl / risk : 0,
      outcome,
    });
    i = exitIndex + 1;
  }

  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.r;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  const wins = trades.filter((t) => t.r > 0).length;
  const totalR = trades.reduce((n, t) => n + t.r, 0);
  const byOutcome: Record<string, number> = {};
  for (const t of trades) byOutcome[t.outcome] = (byOutcome[t.outcome] ?? 0) + 1;
  const round = (x: number) => Number(x.toFixed(3));
  return {
    detector,
    bars: candles.length,
    trades: trades.length,
    wins,
    winRate: trades.length ? round(wins / trades.length) : 0,
    avgR: trades.length ? round(totalR / trades.length) : 0,
    totalR: round(totalR),
    maxDrawdownR: round(maxDd),
    byOutcome,
    sample: trades.slice(-5).map((t) => ({ ...t, r: round(t.r) })),
  };
}
