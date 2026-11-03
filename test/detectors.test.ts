import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/market/detectors.js";
import { backtestDetector } from "../src/market/backtest.js";
import { trendCandles } from "./helpers.js";

const TF = 900_000;

test("a high-volume close above the range is a long breakout with a 2R bracket", () => {
  const analysis = analyze(trendCandles(300, TF, { breakout: true }), { targetR: 2, nearAtr: 0.35 });
  assert.ok(analysis);
  const breakout = analysis.setups.find((s) => s.detector === "breakout");
  assert.ok(breakout, `expected a breakout, got ${JSON.stringify(analysis.setups)}`);
  assert.equal(breakout.side, "long");
  assert.ok(breakout.score >= 0.6, `score ${breakout.score}`);
  assert.ok(breakout.stop < breakout.entry && breakout.target > breakout.entry);
  const risk = breakout.entry - breakout.stop;
  assert.ok(Math.abs(breakout.target - breakout.entry - 2 * risk) < 1e-9);
});

test("the same series without the breakout bar has no breakout", () => {
  const analysis = analyze(trendCandles(300, TF), { targetR: 2, nearAtr: 0.35 });
  assert.ok(analysis);
  assert.equal(analysis.setups.filter((s) => s.detector === "breakout").length, 0);
});

test("fewer candles than the indicators need gives no analysis", () => {
  assert.equal(analyze(trendCandles(150, TF), { targetR: 2, nearAtr: 0.35 }), undefined);
});

test("the backtest walks forward and reports consistent stats", () => {
  const result = backtestDetector(trendCandles(800, TF), "all", { targetR: 2 });
  assert.equal(result.bars, 800);
  assert.ok(result.winRate >= 0 && result.winRate <= 1);
  assert.equal(result.wins + (result.trades - result.wins), result.trades);
  const outcomes = Object.values(result.byOutcome).reduce((a, b) => a + b, 0);
  assert.equal(outcomes, result.trades);
});

test("a cancelled backtest stops", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => backtestDetector(trendCandles(800, TF), "all", { targetR: 2, signal: controller.signal }), /cancelled/);
});
