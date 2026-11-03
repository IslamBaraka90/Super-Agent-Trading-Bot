import { BinanceMarketData, closedOnly } from "../market/binance.js";
import { PaperBroker, type PaperConfig } from "../trading/paper-broker.js";
import type { RiskLimits } from "../trading/risk.js";
import type { Candle, Side } from "../market/types.js";
import { logger } from "../util/log.js";

const log = logger("endpoint");

/** Where market data comes from. Binance by default; tests inject a fixed series. */
export interface MarketDataSource {
  candles(symbol: string, interval: string, limit?: number): Promise<Candle[]>;
  history(symbol: string, interval: string, total: number): Promise<Candle[]>;
  price(symbol: string): Promise<number>;
}

export interface EndpointConfig {
  marketDataUrl: string;
  ledgerPath: string;
  symbols: string[];
  paper: PaperConfig;
  risk: RiskLimits;
  bracketPollMs?: number;
  market?: MarketDataSource;
}

/**
 * The execution endpoint (design §5.2): the only component that touches the
 * environment - market data, the broker ledger and the risk guard. It keeps
 * no agent state and runs either in-process or as its own daemon.
 */
export class ExecutionEndpoint {
  readonly market: MarketDataSource;
  readonly broker: PaperBroker;
  private timer?: NodeJS.Timeout;
  private priceCache = new Map<string, { price: number; at: number }>();
  private monitoring = false;

  constructor(private readonly config: EndpointConfig) {
    this.market = config.market ?? new BinanceMarketData(config.marketDataUrl);
    this.broker = new PaperBroker(config.ledgerPath, config.paper, config.risk, config.symbols);
  }

  /** Start the bracket monitor: checks stops and targets on closed 1m candles. */
  start(): void {
    if (this.timer) return;
    const every = this.config.bracketPollMs ?? 15_000;
    this.timer = setInterval(() => void this.checkBrackets(), every);
    void this.checkBrackets();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.broker.shutdown();
  }

  async checkBrackets(): Promise<void> {
    if (this.monitoring) return;
    this.monitoring = true;
    try {
      const symbols = [...new Set(this.broker.positions("open").map((p) => p.symbol))];
      for (const symbol of symbols) {
        const candles = closedOnly(await this.market.candles(symbol, "1m", 5));
        for (const candle of candles) this.broker.onCandle(symbol, candle);
      }
    } catch (err) {
      log.warn("bracket check failed", err);
    } finally {
      this.monitoring = false;
    }
  }

  private async price(symbol: string): Promise<number> {
    const cached = this.priceCache.get(symbol);
    if (cached && Date.now() - cached.at < 5_000) return cached.price;
    const price = await this.market.price(symbol);
    this.priceCache.set(symbol, { price, at: Date.now() });
    return price;
  }

  private async openPrices(): Promise<Record<string, number>> {
    const prices: Record<string, number> = {};
    for (const p of this.broker.positions("open")) prices[p.symbol] ??= await this.price(p.symbol);
    return prices;
  }

  /** JSON-RPC style dispatch. Every method takes and returns plain JSON. */
  async handle(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const s = (key: string) => {
      const v = params[key];
      if (typeof v !== "string" || !v) throw new Error(`${method}: "${key}" is required`);
      return v;
    };
    const n = (key: string) => {
      const v = params[key];
      return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    };

    switch (method) {
      case "health":
        return { ok: true, at: Date.now(), broker: "paper", openPositions: this.broker.positions("open").length };

      case "market.candles": {
        const candles = await this.market.candles(s("symbol"), s("interval"), n("limit") ?? 300);
        return params.includeForming ? candles : closedOnly(candles);
      }
      case "market.history":
        return closedOnly(await this.market.history(s("symbol"), s("interval"), n("total") ?? 1000));
      case "market.price":
        return this.price(s("symbol"));

      case "broker.account":
        return this.broker.account(await this.openPrices());
      case "broker.positions": {
        const status = (params.status as "open" | "closed" | "all" | undefined) ?? "open";
        const positions = this.broker.positions(status, n("limit") ?? 50);
        if (status === "closed") return positions;
        const prices = await this.openPrices();
        return positions.map((p) => {
          if (p.status !== "open") return p;
          const price = prices[p.symbol] ?? p.entryPrice;
          const unrealized = p.side === "long" ? (price - p.entryPrice) * p.quantity : (p.entryPrice - price) * p.quantity;
          return { ...p, markPrice: price, unrealized, unrealizedR: p.riskAmount ? unrealized / p.riskAmount : 0 };
        });
      }
      case "broker.position":
        return this.broker.position(s("id")) ?? null;
      case "broker.closedSince":
        return this.broker.closedSince(n("since") ?? 0);
      case "broker.events":
        return this.broker.events(n("since") ?? 0, n("limit") ?? 200);

      case "broker.open": {
        const symbol = s("symbol");
        const side = s("side") as Side;
        if (side !== "long" && side !== "short") throw new Error('side must be "long" or "short"');
        const price = await this.price(symbol);
        const result = this.broker.open(
          {
            symbol,
            side,
            stop: n("stop") ?? NaN,
            target: n("target"),
            quantity: n("quantity"),
            riskPct: n("riskPct"),
            meta: (params.meta as Record<string, unknown>) ?? {},
          },
          price,
          await this.openPrices(),
        );
        if (result.ok) log.info(`opened ${result.position.id} ${side} ${symbol} @ ${result.position.entryPrice}`);
        else log.info(`order rejected: ${result.reason}`);
        return result;
      }
      case "broker.close": {
        const position = this.broker.position(s("id"));
        if (!position || position.status !== "open") return { ok: false, reason: "position is not open" };
        const closed = this.broker.close(position.id, await this.price(position.symbol), String(params.reason ?? "manual"));
        return { ok: true, position: closed };
      }
      case "broker.updateBrackets":
        return this.broker.updateBrackets(
          s("id"),
          n("stop"),
          params.target === null ? null : n("target"),
        );

      case "risk.killSwitch":
        this.broker.setKillSwitch(Boolean(params.on), String(params.reason ?? ""));
        return { killSwitch: this.broker.killSwitch, reason: this.broker.killSwitchReason() };
      case "risk.status":
        return {
          killSwitch: this.broker.killSwitch,
          reason: this.broker.killSwitchReason(),
          limits: this.config.risk,
          paper: this.config.paper,
          symbols: this.config.symbols,
        };

      default:
        throw new Error(`Unknown endpoint method "${method}"`);
    }
  }
}
