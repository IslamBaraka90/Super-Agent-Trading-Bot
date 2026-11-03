import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOrder, type RiskContext, type RiskLimits } from "../src/trading/risk.js";

const limits: RiskLimits = { riskPerTradePct: 0.5, maxPositionPct: 20, maxOpenPositions: 3, maxDailyLossPct: 3, stopoutCooldownMin: 60 };

const ctx = (over: Partial<RiskContext> = {}): RiskContext => ({
  price: 100,
  equity: 10_000,
  cash: 10_000,
  dayStartEquity: 10_000,
  openPositions: [],
  killSwitch: false,
  allowedSymbols: ["BTCUSDT", "ETHUSDT"],
  allowShorts: false,
  feeBps: 10,
  now: Date.now(),
  ...over,
});

test("sizing from risk: 0.5% of 10,000 over a 4-point stop is 12.5 units", () => {
  const d = checkOrder({ symbol: "BTCUSDT", side: "long", stop: 96 }, ctx(), limits);
  assert.ok(d.ok);
  assert.equal(d.quantity, 12.5);
  assert.equal(d.riskAmount, 50);
});

test("sizing is capped by the notional limit", () => {
  // 0.5% risk over a 0.2-point stop would be 250 units = 25,000 notional; the 20% cap allows 2,000 = 20 units.
  const d = checkOrder({ symbol: "BTCUSDT", side: "long", stop: 99.8 }, ctx(), limits);
  assert.ok(d.ok);
  assert.equal(d.quantity, 20);
});

test("an explicit size that breaks a rule is rejected with the maximum, never shrunk", () => {
  const d = checkOrder({ symbol: "BTCUSDT", side: "long", stop: 98, quantity: 100 }, ctx(), limits);
  assert.equal(d.ok, false);
  assert.match((d as { reason: string }).reason, /maximum here is 20/);
});

const rejects: [string, Parameters<typeof checkOrder>[0], Partial<RiskContext>, RegExp][] = [
  ["kill switch", { symbol: "BTCUSDT", side: "long", stop: 98 }, { killSwitch: true }, /kill switch/],
  ["stop on the wrong side", { symbol: "BTCUSDT", side: "long", stop: 101 }, {}, /must be below/],
  ["target on the wrong side", { symbol: "BTCUSDT", side: "long", stop: 98, target: 99 }, {}, /target/],
  ["unknown symbol", { symbol: "DOGEUSDT", side: "long", stop: 98 }, {}, /not in SYMBOLS/],
  ["shorts disabled", { symbol: "BTCUSDT", side: "short", stop: 102 }, {}, /shorts are disabled/],
  ["already in the symbol", { symbol: "BTCUSDT", side: "long", stop: 98 }, { openPositions: [{ symbol: "BTCUSDT" }] }, /already open/],
  [
    "too many positions",
    { symbol: "BTCUSDT", side: "long", stop: 98 },
    { openPositions: [{ symbol: "A" }, { symbol: "B" }, { symbol: "C" }] },
    /max open positions/,
  ],
  ["daily loss limit", { symbol: "BTCUSDT", side: "long", stop: 98 }, { equity: 9_650 }, /daily loss limit/],
  ["stop-out cooldown", { symbol: "BTCUSDT", side: "long", stop: 98 }, { lastStopOutAt: Date.now() - 10 * 60_000 }, /cooldown/],
  ["risk above the maximum", { symbol: "BTCUSDT", side: "long", stop: 98, riskPct: 2 }, {}, /exceeds the per-trade maximum/],
  ["stop too tight", { symbol: "BTCUSDT", side: "long", stop: 99.99 }, {}, /closer than 0.05%/],
];

for (const [name, req, over, pattern] of rejects) {
  test(`rejects: ${name}`, () => {
    const d = checkOrder(req, ctx(over), limits);
    assert.equal(d.ok, false);
    assert.match((d as { reason: string }).reason, pattern);
  });
}

test("shorts size correctly when allowed", () => {
  const d = checkOrder({ symbol: "ETHUSDT", side: "short", stop: 102 }, ctx({ allowShorts: true }), limits);
  assert.ok(d.ok);
  assert.equal(d.quantity, 20); // 25 by risk, capped to 20 by notional
});
