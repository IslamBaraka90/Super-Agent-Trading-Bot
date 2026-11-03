import { atr, bollinger, donchian, ema, percentileRank, rsi, volumeZ } from "./indicators.js";
import type { Candle, Side } from "./types.js";

/**
 * Deterministic setup detectors (design §7.2). They are the fast path: code
 * finds the candidates, the models judge and explain them.
 */

export const DETECTORS = ["trend_pullback", "breakout", "rsi_reversal", "squeeze_release"] as const;
export type DetectorName = (typeof DETECTORS)[number];

export interface Setup {
  detector: DetectorName;
  side: Side;
  entry: number;
  stop: number;
  target: number;
  score: number;
  atr: number;
  reason: string;
}

export interface NearSetup {
  detector: DetectorName;
  side: Side;
  level: number;
  distanceAtr: number;
  reason: string;
}

export interface Snapshot {
  close: number;
  ema20: number;
  ema50: number;
  ema200: number;
  rsi: number;
  atr: number;
  atrPct: number;
  bbUpper: number;
  bbLower: number;
  bbWidthPctile: number;
  donchianHigh: number;
  donchianLow: number;
  volZ: number;
  trend: "up" | "down" | "flat";
  changePct: number;
}

export interface Series {
  candles: Candle[];
  close: number[];
  ema20: number[];
  ema50: number[];
  ema200: number[];
  rsi: number[];
  atr: number[];
  bb: ReturnType<typeof bollinger>;
  dc: ReturnType<typeof donchian>;
  volZ: number[];
}

export const MIN_BARS = 210;

export function computeSeries(candles: Candle[]): Series {
  const close = candles.map((c) => c.close);
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  return {
    candles,
    close,
    ema20: ema(close, 20),
    ema50: ema(close, 50),
    ema200: ema(close, 200),
    rsi: rsi(close, 14),
    atr: atr(high, low, close, 14),
    bb: bollinger(close, 20, 2),
    dc: donchian(high, low, 20),
    volZ: volumeZ(
      candles.map((c) => c.volume),
      20,
    ),
  };
}

export function snapshotAt(s: Series, i: number): Snapshot {
  const c = s.candles[i];
  const prev = s.candles[i - 1];
  const trend =
    s.ema20[i] > s.ema50[i] && s.close[i] > s.ema200[i]
      ? "up"
      : s.ema20[i] < s.ema50[i] && s.close[i] < s.ema200[i]
        ? "down"
        : "flat";
  return {
    close: c.close,
    ema20: s.ema20[i],
    ema50: s.ema50[i],
    ema200: s.ema200[i],
    rsi: s.rsi[i],
    atr: s.atr[i],
    atrPct: (s.atr[i] / c.close) * 100,
    bbUpper: s.bb.upper[i],
    bbLower: s.bb.lower[i],
    bbWidthPctile: percentileRank(s.bb.width, i, 100),
    donchianHigh: s.dc.upper[i],
    donchianLow: s.dc.lower[i],
    volZ: s.volZ[i],
    trend,
    changePct: prev ? ((c.close - prev.close) / prev.close) * 100 : 0,
  };
}

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

function bracket(side: Side, entry: number, stop: number, targetR: number) {
  const risk = Math.abs(entry - stop);
  return { stop, target: side === "long" ? entry + targetR * risk : entry - targetR * risk };
}

/** Run every detector on bar i. Needs i >= MIN_BARS - 1. */
export function detectAt(
  s: Series,
  i: number,
  opts: { targetR: number; nearAtr: number },
): { setups: Setup[]; near: NearSetup[] } {
  const setups: Setup[] = [];
  const near: NearSetup[] = [];
  if (i < MIN_BARS - 1 || i < 1) return { setups, near };
  const c = s.candles[i];
  const p = s.candles[i - 1];
  const a = s.atr[i];
  if (!(a > 0)) return { setups, near };
  const close = c.close;
  const volZ = Number.isFinite(s.volZ[i]) ? s.volZ[i] : 0;
  const upTrend = s.ema20[i] > s.ema50[i] && close > s.ema50[i];
  const downTrend = s.ema20[i] < s.ema50[i] && close < s.ema50[i];

  // trend_pullback: price tags the EMA20 inside a trend and closes back with it.
  const trendGap = Math.abs(s.ema20[i] - s.ema50[i]) / a;
  if (upTrend && Math.min(c.low, p.low) <= s.ema20[i] * 1.001 && close > s.ema20[i] && close > c.open) {
    const stop = Math.min(c.low, p.low) - 0.5 * a;
    const score = clamp(0.45 + 0.1 * clamp(trendGap, 0, 2) + (s.rsi[i] > 40 && s.rsi[i] < 65 ? 0.1 : 0) + 0.05 * clamp(volZ, 0, 2));
    setups.push({
      detector: "trend_pullback",
      side: "long",
      entry: close,
      ...bracket("long", close, stop, opts.targetR),
      score,
      atr: a,
      reason: `uptrend (EMA20 ${trendGap.toFixed(1)} ATR above EMA50), pullback to EMA20 held, bullish close`,
    });
  }
  if (downTrend && Math.max(c.high, p.high) >= s.ema20[i] * 0.999 && close < s.ema20[i] && close < c.open) {
    const stop = Math.max(c.high, p.high) + 0.5 * a;
    const score = clamp(0.45 + 0.1 * clamp(trendGap, 0, 2) + (s.rsi[i] < 60 && s.rsi[i] > 35 ? 0.1 : 0) + 0.05 * clamp(volZ, 0, 2));
    setups.push({
      detector: "trend_pullback",
      side: "short",
      entry: close,
      ...bracket("short", close, stop, opts.targetR),
      score,
      atr: a,
      reason: `downtrend (EMA20 ${trendGap.toFixed(1)} ATR below EMA50), rally to EMA20 rejected, bearish close`,
    });
  }

  // breakout: close beyond the prior 20-bar range on above-normal volume.
  const dcHigh = s.dc.upper[i];
  const dcLow = s.dc.lower[i];
  const range = c.high - c.low || a;
  if (close > dcHigh && volZ > 1.5) {
    const closeStrength = (close - c.low) / range;
    const score = clamp(0.4 + 0.12 * clamp(volZ - 1.5, 0, 2.5) + 0.15 * closeStrength + (close > s.ema200[i] ? 0.1 : 0));
    setups.push({
      detector: "breakout",
      side: "long",
      entry: close,
      ...bracket("long", close, close - 1.5 * a, opts.targetR),
      score,
      atr: a,
      reason: `close above 20-bar high ${dcHigh.toPrecision(6)} on volume z=${volZ.toFixed(1)}`,
    });
  } else if (Number.isFinite(dcHigh) && close < dcHigh && (dcHigh - close) / a <= opts.nearAtr && volZ > 0.5) {
    near.push({
      detector: "breakout",
      side: "long",
      level: dcHigh,
      distanceAtr: (dcHigh - close) / a,
      reason: `${((dcHigh - close) / a).toFixed(2)} ATR below the 20-bar high with rising volume`,
    });
  }
  if (close < dcLow && volZ > 1.5) {
    const closeStrength = (c.high - close) / range;
    const score = clamp(0.4 + 0.12 * clamp(volZ - 1.5, 0, 2.5) + 0.15 * closeStrength + (close < s.ema200[i] ? 0.1 : 0));
    setups.push({
      detector: "breakout",
      side: "short",
      entry: close,
      ...bracket("short", close, close + 1.5 * a, opts.targetR),
      score,
      atr: a,
      reason: `close below 20-bar low ${dcLow.toPrecision(6)} on volume z=${volZ.toFixed(1)}`,
    });
  } else if (Number.isFinite(dcLow) && close > dcLow && (close - dcLow) / a <= opts.nearAtr && volZ > 0.5) {
    near.push({
      detector: "breakout",
      side: "short",
      level: dcLow,
      distanceAtr: (close - dcLow) / a,
      reason: `${((close - dcLow) / a).toFixed(2)} ATR above the 20-bar low with rising volume`,
    });
  }

  // rsi_reversal: RSI leaves an extreme in the direction of the long-term trend.
  const rPrev = s.rsi[i - 1];
  const rNow = s.rsi[i];
  if (rPrev < 30 && rNow >= 30 && close > s.ema200[i]) {
    let low = Infinity;
    for (let j = Math.max(0, i - 4); j <= i; j++) low = Math.min(low, s.candles[j].low);
    const score = clamp(0.45 + 0.15 * clamp((close - s.ema200[i]) / a / 3, 0, 1) + 0.1 * clamp(volZ, 0, 2) / 2);
    setups.push({
      detector: "rsi_reversal",
      side: "long",
      entry: close,
      ...bracket("long", close, low - 0.25 * a, opts.targetR),
      score,
      atr: a,
      reason: `RSI crossed back above 30 (${rPrev.toFixed(1)} -> ${rNow.toFixed(1)}) above EMA200`,
    });
  }
  if (rPrev > 70 && rNow <= 70 && close < s.ema200[i]) {
    let high = -Infinity;
    for (let j = Math.max(0, i - 4); j <= i; j++) high = Math.max(high, s.candles[j].high);
    const score = clamp(0.45 + 0.15 * clamp((s.ema200[i] - close) / a / 3, 0, 1) + 0.1 * clamp(volZ, 0, 2) / 2);
    setups.push({
      detector: "rsi_reversal",
      side: "short",
      entry: close,
      ...bracket("short", close, high + 0.25 * a, opts.targetR),
      score,
      atr: a,
      reason: `RSI crossed back below 70 (${rPrev.toFixed(1)} -> ${rNow.toFixed(1)}) below EMA200`,
    });
  }

  // squeeze_release: a close outside the bands after volatility compressed.
  const squeezed = percentileRank(s.bb.width, i - 1, 100) <= 0.1;
  if (squeezed && close > s.bb.upper[i]) {
    const score = clamp(0.5 + 0.1 * clamp(volZ, 0, 2) + (s.ema20[i] > s.ema50[i] ? 0.1 : 0));
    setups.push({
      detector: "squeeze_release",
      side: "long",
      entry: close,
      ...bracket("long", close, Math.min(s.bb.mid[i], close - a), opts.targetR),
      score,
      atr: a,
      reason: "Bollinger width in its lowest 10% of 100 bars, close above the upper band",
    });
  }
  if (squeezed && close < s.bb.lower[i]) {
    const score = clamp(0.5 + 0.1 * clamp(volZ, 0, 2) + (s.ema20[i] < s.ema50[i] ? 0.1 : 0));
    setups.push({
      detector: "squeeze_release",
      side: "short",
      entry: close,
      ...bracket("short", close, Math.max(s.bb.mid[i], close + a), opts.targetR),
      score,
      atr: a,
      reason: "Bollinger width in its lowest 10% of 100 bars, close below the lower band",
    });
  }

  for (const setup of setups) setup.score = Number(setup.score.toFixed(2));
  return { setups, near };
}

export interface Analysis {
  snapshot: Snapshot;
  setups: Setup[];
  near: NearSetup[];
  candle: Candle;
}

/** Analyse the last candle of a closed-candle series. */
export function analyze(candles: Candle[], opts: { targetR: number; nearAtr: number }): Analysis | undefined {
  if (candles.length < MIN_BARS) return undefined;
  const series = computeSeries(candles);
  const i = candles.length - 1;
  const { setups, near } = detectAt(series, i, opts);
  return { snapshot: snapshotAt(series, i), setups, near, candle: candles[i] };
}
