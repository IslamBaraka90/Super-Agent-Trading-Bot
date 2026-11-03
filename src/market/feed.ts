import type { Timeframe } from "../config.js";
import { makeTrigger } from "../events/trigger.js";
import type { Runtime } from "../runtime.js";
import { analyze } from "./detectors.js";
import type { Candle } from "./types.js";
import { TF_MS, marketThread } from "./types.js";
import { fmtPct, fmtPrice } from "../util/text.js";
import { logger } from "../util/log.js";

const log = logger("feed");

const r6 = (x: number) => (Number.isFinite(x) ? Number(x.toPrecision(6)) : x);

/**
 * Turns candle closes into triggers (design §7.1). Each timeframe polls right
 * after its next close; the first poll only records where it is, so a restart
 * never replays old candles as new events.
 */
export class MarketFeed {
  lastSuccessAt = 0;
  lastError: string | null = null;
  private lastOpen = new Map<string, number>();
  private timers = new Map<Timeframe, NodeJS.Timeout>();
  private stopped = false;

  constructor(private readonly rt: Runtime) {}

  async start(): Promise<void> {
    this.stopped = false;
    for (const tf of this.rt.config.timeframes) {
      for (const symbol of this.rt.config.symbols) this.rt.threads.ensure(marketThread(symbol, tf));
    }
    for (const tf of this.rt.config.timeframes) {
      const delay = await this.poll(tf);
      this.schedule(tf, delay);
    }
    log.info(`watching ${this.rt.config.symbols.join(", ")} on ${this.rt.config.timeframes.join(", ")}`);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private schedule(tf: Timeframe, delay: number): void {
    if (this.stopped) return;
    const timer = setTimeout(async () => {
      const next = await this.poll(tf);
      this.schedule(tf, next);
    }, delay);
    timer.unref?.();
    this.timers.set(tf, timer);
  }

  /** Poll one timeframe for every symbol. Returns the delay until the next poll. */
  async poll(tf: Timeframe, now = Date.now()): Promise<number> {
    let nextClose = Infinity;
    let failed = false;
    for (const symbol of this.rt.config.symbols) {
      try {
        const candles = await this.rt.endpoint.call<Candle[]>("market.candles", { symbol, interval: tf, limit: 300 });
        if (candles.length) nextClose = Math.min(nextClose, candles[candles.length - 1].closeTime + TF_MS[tf]);
        this.process(symbol, tf, candles);
        this.lastSuccessAt = Date.now();
      } catch (err) {
        failed = true;
        this.lastError = (err as Error).message;
        log.warn(`poll ${symbol} ${tf} failed`, err);
      }
    }
    this.rt.speculator.sweep();
    const delay = Number.isFinite(nextClose) ? nextClose + 1_500 - now : 10_000;
    return Math.max(2_000, failed ? Math.min(delay, 15_000) : delay);
  }

  /** Handle a fresh batch of closed candles for one symbol and timeframe. */
  process(symbol: string, tf: Timeframe, candles: Candle[]): void {
    if (candles.length === 0) return;
    const thread = marketThread(symbol, tf);
    const last = candles[candles.length - 1];
    const prev = this.lastOpen.get(thread);
    if (prev !== undefined && last.openTime <= prev) return;
    this.lastOpen.set(thread, last.openTime);
    if (prev === undefined) return; // first sight: remember the position, emit nothing

    for (const c of candles) if (c.openTime > prev) this.rt.signals.onCandle(symbol, tf, c);

    const analysis = analyze(candles, { targetR: this.rt.config.targetR, nearAtr: this.rt.config.nearSetupAtr });
    if (!analysis) return;
    if (analysis.near.length) this.rt.speculator.onNear(symbol, tf, analysis.near, last);

    const s = analysis.snapshot;
    const best = [...analysis.setups].sort((a, b) => b.score - a.score)[0];
    const trigger = makeTrigger({
      source: "market",
      kind: "candle_closed",
      threadKey: thread,
      summary:
        `${symbol} ${tf} closed ${fmtPrice(last.close)} (${fmtPct(s.changePct)})` +
        (best ? ` | setup ${best.detector} ${best.side} score ${best.score}` : ""),
      payload: {
        symbol,
        timeframe: tf,
        candle: last,
        snapshot: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === "number" ? r6(v) : v])),
        setups: analysis.setups.map((x) => ({ ...x, entry: r6(x.entry), stop: r6(x.stop), target: r6(x.target), atr: r6(x.atr) })),
      },
      dedupeKey: `${thread}:${last.openTime}`,
    });
    this.rt.speculator.attach(trigger);
    this.rt.ingest(trigger);
  }
}
