import type { Side } from "../market/types.js";

/**
 * Risk guard (design §7.5). Pure code, evaluated inside the execution endpoint
 * for every order. It never shrinks an explicit size silently: an explicit
 * quantity that breaks a rule is rejected with the maximum allowed.
 */

export interface RiskLimits {
  riskPerTradePct: number;
  maxPositionPct: number;
  maxOpenPositions: number;
  maxDailyLossPct: number;
  stopoutCooldownMin: number;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  stop: number;
  target?: number;
  /** Explicit size in base units. Omit to size from risk. */
  quantity?: number;
  /** Percent of equity to risk. Omit to use the configured maximum. */
  riskPct?: number;
}

export interface RiskContext {
  price: number;
  equity: number;
  cash: number;
  dayStartEquity: number;
  openPositions: { symbol: string }[];
  lastStopOutAt?: number;
  killSwitch: boolean;
  allowedSymbols: string[];
  allowShorts: boolean;
  feeBps: number;
  now: number;
}

export type RiskDecision =
  | { ok: true; quantity: number; riskAmount: number; notional: number }
  | { ok: false; reason: string };

export function checkOrder(req: OrderRequest, ctx: RiskContext, limits: RiskLimits): RiskDecision {
  const reject = (reason: string): RiskDecision => ({ ok: false, reason });
  const { price, equity } = ctx;

  if (ctx.killSwitch) return reject("kill switch is on: no new entries until it is cleared");
  if (!ctx.allowedSymbols.includes(req.symbol)) return reject(`${req.symbol} is not in SYMBOLS`);
  if (req.side === "short" && !ctx.allowShorts) return reject("shorts are disabled (ALLOW_SHORTS=false)");
  if (!(price > 0) || !(equity > 0)) return reject("no valid price or equity");
  if (!Number.isFinite(req.stop) || req.stop <= 0) return reject("a stop is required on every entry");
  if (req.side === "long" && req.stop >= price) return reject(`long stop ${req.stop} must be below price ${price}`);
  if (req.side === "short" && req.stop <= price) return reject(`short stop ${req.stop} must be above price ${price}`);
  if (req.target !== undefined) {
    if (req.side === "long" && req.target <= price) return reject(`long target ${req.target} must be above price ${price}`);
    if (req.side === "short" && req.target >= price) return reject(`short target ${req.target} must be below price ${price}`);
  }
  const stopDistance = Math.abs(price - req.stop);
  if (stopDistance / price < 0.0005) return reject("stop is closer than 0.05% of price");

  if (ctx.openPositions.some((p) => p.symbol === req.symbol)) {
    return reject(`a position in ${req.symbol} is already open`);
  }
  if (ctx.openPositions.length >= limits.maxOpenPositions) {
    return reject(`max open positions reached (${limits.maxOpenPositions})`);
  }
  const dayPnlPct = ((equity - ctx.dayStartEquity) / ctx.dayStartEquity) * 100;
  if (dayPnlPct <= -limits.maxDailyLossPct) {
    return reject(`daily loss limit hit (${dayPnlPct.toFixed(2)}% vs -${limits.maxDailyLossPct}%)`);
  }
  if (ctx.lastStopOutAt !== undefined) {
    const minutes = (ctx.now - ctx.lastStopOutAt) / 60_000;
    if (minutes < limits.stopoutCooldownMin) {
      return reject(
        `${req.symbol} stopped out ${minutes.toFixed(0)} min ago; cooldown is ${limits.stopoutCooldownMin} min`,
      );
    }
  }

  const riskPct = req.riskPct ?? limits.riskPerTradePct;
  if (!(riskPct > 0)) return reject("riskPct must be positive");
  if (riskPct > limits.riskPerTradePct) {
    return reject(`riskPct ${riskPct}% exceeds the per-trade maximum ${limits.riskPerTradePct}%`);
  }
  const maxRiskAmount = (equity * limits.riskPerTradePct) / 100;
  const maxNotional = (equity * limits.maxPositionPct) / 100;
  const feeFactor = 1 + ctx.feeBps / 10_000;
  const cashCap = req.side === "long" ? ctx.cash / (price * feeFactor) : Infinity;

  let quantity: number;
  if (req.quantity !== undefined) {
    quantity = req.quantity;
    if (!(quantity > 0)) return reject("quantity must be positive");
    const maxByRisk = maxRiskAmount / stopDistance;
    const maxByNotional = maxNotional / price;
    const maxQty = Math.min(maxByRisk, maxByNotional, cashCap);
    if (quantity > maxQty * 1.000001) {
      return reject(
        `quantity ${quantity} breaks the limits; the maximum here is ${round(maxQty)} ` +
          `(risk cap ${round(maxByRisk)}, notional cap ${round(maxByNotional)}${Number.isFinite(cashCap) ? `, cash cap ${round(cashCap)}` : ""})`,
      );
    }
  } else {
    // Sizing from risk: the largest size the rules allow at the requested risk.
    quantity = Math.min((equity * riskPct) / 100 / stopDistance, maxNotional / price, cashCap);
  }
  if (!(quantity > 0)) return reject("no size available (insufficient cash?)");

  return { ok: true, quantity, riskAmount: quantity * stopDistance, notional: quantity * price };
}

function round(x: number): number {
  return Number(x.toPrecision(6));
}
