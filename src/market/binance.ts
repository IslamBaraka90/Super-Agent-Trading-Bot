import type { Candle } from "./types.js";

/**
 * Binance public market data. No API key: the default host
 * (data-api.binance.vision) serves market data only.
 */
export class BinanceMarketData {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  /** Most recent `limit` candles, oldest first. The last one may still be forming. */
  async candles(symbol: string, interval: string, limit = 300, endTime?: number): Promise<Candle[]> {
    const params = new URLSearchParams({ symbol, interval, limit: String(Math.min(Math.max(limit, 1), 1000)) });
    if (endTime !== undefined) params.set("endTime", String(endTime));
    const rows = await this.get<unknown[][]>(`/api/v3/klines?${params}`);
    return rows.map((r) => ({
      openTime: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      closeTime: Number(r[6]),
    }));
  }

  /** Up to `total` candles by paging backwards (Binance caps a page at 1000). */
  async history(symbol: string, interval: string, total: number): Promise<Candle[]> {
    let out: Candle[] = [];
    let endTime: number | undefined;
    while (out.length < total) {
      const page = await this.candles(symbol, interval, Math.min(1000, total - out.length), endTime);
      if (page.length === 0) break;
      out = [...page, ...out];
      endTime = page[0].openTime - 1;
      if (page.length < 1000) break;
    }
    return out.slice(-total);
  }

  async price(symbol: string): Promise<number> {
    const data = await this.get<{ price: string }>(`/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
    const price = Number(data.price);
    if (!Number.isFinite(price)) throw new Error(`Bad price for ${symbol}`);
    return price;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(this.baseUrl + path, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Market data ${res.status} for ${path}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }
}

/** Candles whose close time has passed. */
export function closedOnly(candles: Candle[], now = Date.now()): Candle[] {
  return candles.filter((c) => c.closeTime < now);
}
