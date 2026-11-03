/**
 * Indicator series. Every function returns an array aligned with its input,
 * with NaN until the indicator has enough history. No look-ahead: value i
 * uses inputs 0..i only.
 */

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values. */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  gain /= period;
  loss /= period;
  out[period] = rsiValue(gain, loss);
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = rsiValue(gain, loss);
  }
  return out;
}

function rsiValue(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Wilder's ATR. */
export function atr(highs: number[], lows: number[], closes: number[], period = 14): number[] {
  const n = closes.length;
  const out = new Array<number>(n).fill(NaN);
  if (n <= period) return out;
  const tr = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  let prev = 0;
  for (let i = 1; i <= period; i++) prev += tr[i];
  prev /= period;
  out[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export interface BollingerSeries {
  mid: number[];
  upper: number[];
  lower: number[];
  /** (upper - lower) / mid */
  width: number[];
}

export function bollinger(closes: number[], period = 20, mult = 2): BollingerSeries {
  const n = closes.length;
  const mid = sma(closes, period);
  const upper = new Array<number>(n).fill(NaN);
  const lower = new Array<number>(n).fill(NaN);
  const width = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(variance / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    width[i] = mid[i] === 0 ? NaN : (upper[i] - lower[i]) / mid[i];
  }
  return { mid, upper, lower, width };
}

/** Highest high / lowest low of the `period` bars BEFORE bar i (bar i excluded). */
export function donchian(highs: number[], lows: number[], period = 20): { upper: number[]; lower: number[] } {
  const n = highs.length;
  const upper = new Array<number>(n).fill(NaN);
  const lower = new Array<number>(n).fill(NaN);
  for (let i = period; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period; j < i; j++) {
      if (highs[j] > hi) hi = highs[j];
      if (lows[j] < lo) lo = lows[j];
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

/** z-score of bar i's volume against the `period` bars before it. */
export function volumeZ(volumes: number[], period = 20): number[] {
  const n = volumes.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = period; i < n; i++) {
    let mean = 0;
    for (let j = i - period; j < i; j++) mean += volumes[j];
    mean /= period;
    let variance = 0;
    for (let j = i - period; j < i; j++) variance += (volumes[j] - mean) ** 2;
    const sd = Math.sqrt(variance / period);
    out[i] = sd === 0 ? 0 : (volumes[i] - mean) / sd;
  }
  return out;
}

/** Percentile rank (0..1) of values[i] within the `lookback` values ending at i. */
export function percentileRank(values: number[], i: number, lookback: number): number {
  const start = Math.max(0, i - lookback + 1);
  let below = 0;
  let count = 0;
  for (let j = start; j <= i; j++) {
    if (Number.isNaN(values[j])) continue;
    count++;
    if (values[j] <= values[i]) below++;
  }
  return count === 0 ? NaN : below / count;
}
