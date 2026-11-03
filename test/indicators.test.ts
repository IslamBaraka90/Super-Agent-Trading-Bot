import { test } from "node:test";
import assert from "node:assert/strict";
import { atr, bollinger, donchian, ema, rsi, sma, volumeZ } from "../src/market/indicators.js";

test("sma averages the trailing window", () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3).slice(2), [2, 3, 4]);
  assert.ok(Number.isNaN(sma([1, 2, 3], 3)[1]));
});

test("ema is seeded with the SMA, then smooths with alpha 2/(n+1)", () => {
  const out = ema([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(out[1]));
  assert.equal(out[2], 2);
  assert.equal(out[3], 3);
  assert.equal(out[4], 4);
});

test("rsi is 100 on a straight rise and 50 on a flat line", () => {
  const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsi(rising, 14)[29], 100);
  assert.equal(rsi(new Array(30).fill(100), 14)[29], 50);
});

test("atr of a constant 2-point range is 2", () => {
  const n = 30;
  const out = atr(new Array(n).fill(11), new Array(n).fill(9), new Array(n).fill(10), 14);
  assert.equal(out[29], 2);
});

test("donchian excludes the current bar, so a breakout bar can exceed it", () => {
  const { upper } = donchian([1, 2, 3, 4, 10], [0, 0, 0, 0, 0], 3);
  assert.equal(upper[4], 4);
});

test("bollinger width is zero on a flat series and positive otherwise", () => {
  assert.equal(bollinger(new Array(25).fill(5), 20).width[24], 0);
  const noisy = Array.from({ length: 25 }, (_, i) => 100 + (i % 2 ? 1 : -1));
  assert.ok(bollinger(noisy, 20).width[24] > 0);
});

test("volume z flags a spike against the prior window", () => {
  const v = [...new Array(20).fill(100).map((x, i) => x + (i % 2)), 500];
  assert.ok(volumeZ(v, 20)[20] > 10);
});

test("no look-ahead: appending future data never changes past values", () => {
  const base = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5);
  const extended = [...base, 130, 90, 140];
  for (const [a, b] of [
    [ema(base, 10), ema(extended, 10)],
    [rsi(base, 14), rsi(extended, 14)],
    [sma(base, 20), sma(extended, 20)],
  ]) {
    assert.deepEqual(a, b.slice(0, base.length));
  }
});
