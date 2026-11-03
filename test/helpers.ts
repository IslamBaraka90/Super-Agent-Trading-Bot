import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import type { Candle } from "../src/market/types.js";
import type { MarketDataSource } from "../src/endpoint/endpoint.js";
import type { Channel } from "../src/channels/hub.js";
import type { Runtime } from "../src/runtime.js";

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    LLM_PROVIDER: "mock",
    SYMBOLS: "BTCUSDT,ETHUSDT",
    TIMEFRAMES: "15m,1h",
    CONSOLE_CHANNEL: "off",
    HTTP_PORT: "0",
    SPECULATIVE: "off",
    NOTIFY_CHANNELS: "console",
    DATA_DIR: mkdtempSync(join(tmpdir(), "sat-")),
    ...overrides,
  });
}

/**
 * Deterministic candles that end at the last closed candle of `tfMs`: a steady
 * uptrend, a 25-bar range, and (optionally) a final high-volume close above the
 * range - a clean breakout.
 */
export function trendCandles(n: number, tfMs: number, opts: { breakout?: boolean; base?: number; now?: number } = {}): Candle[] {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const base = opts.base ?? 100;
  const currentOpen = Math.floor((opts.now ?? Date.now()) / tfMs) * tfMs;
  const firstOpen = currentOpen - n * tfMs;
  const rangeStart = n - 26;
  const out: Candle[] = [];
  let prevClose = base;
  let rangeLevel = base;
  for (let i = 0; i < n; i++) {
    let close: number;
    let volume = 100 + 20 * rand();
    if (i < rangeStart) {
      close = base * (1 + 0.0015 * i) * (1 + (rand() - 0.5) * 0.002);
      rangeLevel = close;
    } else if (i < n - 1 || !opts.breakout) {
      close = rangeLevel * (1 + (rand() - 0.5) * 0.006);
    } else {
      let hi = 0;
      for (const c of out.slice(-20)) hi = Math.max(hi, c.high);
      close = hi * 1.008;
      volume = 1_000;
    }
    const open = prevClose;
    const high = Math.max(open, close) * (1 + rand() * 0.001);
    const low = Math.min(open, close) * (1 - rand() * 0.001);
    const openTime = firstOpen + i * tfMs;
    out.push({ openTime, open, high, low, close, volume, closeTime: openTime + tfMs - 1 });
    prevClose = close;
  }
  return out;
}

/** Market data from fixed series, keyed by symbol and interval. */
export class FixedMarket implements MarketDataSource {
  private series = new Map<string, Candle[]>();
  private prices = new Map<string, number>();

  set(symbol: string, interval: string, candles: Candle[]): void {
    this.series.set(`${symbol}:${interval}`, candles);
    this.prices.set(symbol, candles[candles.length - 1].close);
  }

  setPrice(symbol: string, price: number): void {
    this.prices.set(symbol, price);
  }

  async candles(symbol: string, interval: string, limit = 300): Promise<Candle[]> {
    return (this.series.get(`${symbol}:${interval}`) ?? []).slice(-limit);
  }

  async history(symbol: string, interval: string, total: number): Promise<Candle[]> {
    return this.candles(symbol, interval, total);
  }

  async price(symbol: string): Promise<number> {
    const p = this.prices.get(symbol);
    if (p === undefined) throw new Error(`no price for ${symbol}`);
    return p;
  }
}

/** Records what the agent sends. Named console so it is the default notify channel. */
export class CaptureChannel implements Channel {
  readonly style = "im" as const;
  readonly inbound = false;
  readonly sent: { text: string; target?: string }[] = [];
  constructor(readonly name = "console") {}
  start(): void {}
  stop(): void {}
  async send(text: string, target?: string): Promise<void> {
    this.sent.push({ text, target });
  }
}

/** Wait until no session is thinking and no queue holds work. */
export async function settle(rt: Runtime, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let quiet = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    const busy =
      rt.router.session.busy ||
      rt.router.session.pending > 0 ||
      rt.watchdog.session.busy ||
      rt.watchdog.session.pending > 0 ||
      rt.semantic.busy ||
      rt.pool.busy;
    quiet = busy ? 0 : quiet + 1;
    if (quiet >= 5) return;
  }
  throw new Error("runtime did not settle");
}
