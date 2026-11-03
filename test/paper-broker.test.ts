import { test } from "node:test";
import assert from "node:assert/strict";
import { PaperBroker } from "../src/trading/paper-broker.js";
import type { Candle } from "../src/market/types.js";

const limits = { riskPerTradePct: 0.5, maxPositionPct: 20, maxOpenPositions: 3, maxDailyLossPct: 3, stopoutCooldownMin: 60 };
const paper = { startingCash: 10_000, feeBps: 10, slippageBps: 0, allowShorts: true };

function broker() {
  return new PaperBroker(":memory:", paper, limits, ["BTCUSDT", "ETHUSDT"]);
}

function minuteAfter(ms: number, k = 1): Candle & { openTime: number } {
  const openTime = Math.ceil(ms / 60_000) * 60_000 + (k - 1) * 60_000;
  return { openTime, closeTime: openTime + 59_999, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1 };
}

test("opening a long debits notional plus fee; equity drops only by the fee", () => {
  const b = broker();
  const now = Date.now();
  const r = b.open({ symbol: "BTCUSDT", side: "long", stop: 98, target: 104 }, 100, {}, now);
  assert.ok(r.ok);
  assert.equal(r.position.quantity, 20);
  const acct = b.account({ BTCUSDT: 100 }, now);
  assert.equal(acct.cash, 10_000 - 2_000 - 2);
  assert.equal(Number(acct.equity.toFixed(6)), 9_998);
});

test("a stop hit closes at the stop, books -1R before fees, and starts the cooldown", () => {
  const b = broker();
  const now = Date.now();
  const r = b.open({ symbol: "BTCUSDT", side: "long", stop: 98 }, 100, {}, now);
  assert.ok(r.ok);
  const closed = b.onCandle("BTCUSDT", { ...minuteAfter(now), low: 97.5, high: 100.2 });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitReason, "stop_hit");
  assert.equal(closed[0].exitPrice, 98);
  assert.equal(Number(closed[0].rMultiple!.toFixed(6)), -1);
  const again = b.open({ symbol: "BTCUSDT", side: "long", stop: 98 }, 100, {}, now + 120_000);
  assert.equal(again.ok, false);
  assert.match((again as { reason: string }).reason, /cooldown/);
  assert.deepEqual(
    b.events(0).map((e) => e.kind),
    ["opened", "stop_hit"],
  );
});

test("a candle touching both levels fills the stop (conservative)", () => {
  const b = broker();
  const now = Date.now();
  b.open({ symbol: "BTCUSDT", side: "long", stop: 98, target: 102 }, 100, {}, now);
  const [p] = b.onCandle("BTCUSDT", { ...minuteAfter(now), low: 97, high: 103 });
  assert.equal(p.exitReason, "stop_hit");
});

test("a gap through the stop fills at the open", () => {
  const b = broker();
  const now = Date.now();
  b.open({ symbol: "BTCUSDT", side: "long", stop: 98 }, 100, {}, now);
  const [p] = b.onCandle("BTCUSDT", { ...minuteAfter(now), open: 96, high: 96.5, low: 95, close: 96 });
  assert.equal(p.exitPrice, 96);
});

test("the entry minute is ignored: its range includes prices from before the position", () => {
  const b = broker();
  const now = Date.now();
  b.open({ symbol: "BTCUSDT", side: "long", stop: 98 }, 100, {}, now);
  const entryMinute = Math.floor(now / 60_000) * 60_000;
  const closed = b.onCandle("BTCUSDT", { openTime: entryMinute, closeTime: entryMinute + 59_999, open: 100, high: 100, low: 90, close: 99, volume: 1 });
  assert.equal(closed.length, 0);
});

test("target hit on a short closes in profit at +2R", () => {
  const b = broker();
  const now = Date.now();
  b.open({ symbol: "ETHUSDT", side: "short", stop: 102, target: 96 }, 100, {}, now);
  const [p] = b.onCandle("ETHUSDT", { ...minuteAfter(now), high: 100.5, low: 95.5 });
  assert.equal(p.exitReason, "target_hit");
  assert.ok(p.pnl! > 0);
  assert.equal(Number(p.rMultiple!.toFixed(6)), 2);
});

test("the kill switch blocks entries", () => {
  const b = broker();
  b.setKillSwitch(true, "test");
  const r = b.open({ symbol: "BTCUSDT", side: "long", stop: 98 }, 100, {});
  assert.equal(r.ok, false);
});
