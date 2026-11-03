import { test } from "node:test";
import assert from "node:assert/strict";
import { ProgrammaticFilter } from "../src/filter/programmatic.js";
import { makeTrigger } from "../src/events/trigger.js";
import { Store } from "../src/state/store.js";
import { renderRecall, renderTrigger } from "../src/context/render.js";
import { ToolRegistry, defineTool } from "../src/agent/tools.js";
import { z } from "zod";
import { testConfig } from "./helpers.js";

const config = testConfig({ MIN_SETUP_SCORE: "0.55", TELEGRAM_GROUP_MODE: "candidate" });

function filter(subscribed: Record<string, string[]> = {}) {
  return new ProgrammaticFilter(config, (thread) => subscribed[thread] ?? []);
}

const market = (setups: { score: number }[], dedupeKey?: string) =>
  makeTrigger({ source: "market", kind: "candle_closed", threadKey: "mkt:BTCUSDT:15m", summary: "c", payload: { setups }, dedupeKey });

test("fast path: market candles", () => {
  assert.equal(filter().decide(market([])).route, "drop");
  assert.equal(filter().decide(market([{ score: 0.4 }])).route, "drop");
  assert.equal(filter().decide(market([{ score: 0.7 }])).route, "semantic");
  assert.equal(filter({ "mkt:BTCUSDT:15m": ["wrk_1"] }).decide(market([])).route, "passthrough");
});

test("fast path: duplicates are dropped", () => {
  const f = filter();
  assert.equal(f.decide(market([{ score: 0.7 }], "k1")).route, "semantic");
  assert.equal(f.decide(market([{ score: 0.7 }], "k1")).route, "drop");
});

test("fast path: chat", () => {
  const chat = (payload: Record<string, unknown>, explicit = false, channel = "telegram") =>
    makeTrigger({ source: "chat", kind: "message", threadKey: "chat:x", summary: "m", payload, explicit, replyTo: { channel } });
  const f = filter();
  assert.equal(f.decide(chat({ text: "hi", allowed: false }, true)).route, "drop");
  assert.equal(f.decide(chat({ text: "/watchdog why", allowed: true }, true)).route, "watchdog");
  assert.equal(f.decide(chat({ text: "buy?", allowed: true }, true)).route, "router");
  assert.equal(f.decide(chat({ text: "lol", allowed: true, isGroup: true })).route, "semantic");
  assert.equal(f.decide(chat({ text: "", allowed: true }, true)).route, "drop");
});

test("fast path: broker, job, worker and schedule events", () => {
  const t = (source: "broker" | "job" | "worker" | "schedule", thread: string) =>
    makeTrigger({ source, kind: "k", threadKey: thread, summary: "s", payload: {} });
  assert.equal(filter().decide(t("broker", "pos:pos_1")).route, "router");
  assert.equal(filter({ "pos:pos_1": ["wrk_1"] }).decide(t("broker", "pos:pos_1")).route, "passthrough");
  assert.equal(filter().decide(t("job", "job:job_1")).route, "drop");
  assert.equal(filter({ "job:job_1": ["wrk_1"] }).decide(t("job", "job:job_1")).route, "subscribers");
  assert.equal(filter().decide(t("worker", "wrk:wrk_1")).route, "router");
  assert.equal(filter().decide(t("schedule", "digest:d")).route, "router");
});

test("inline & spill: long trigger bodies are cut with a recall pointer that resumes", () => {
  const store = new Store(":memory:");
  const long = "word ".repeat(400);
  const t = makeTrigger({ source: "chat", kind: "message", threadKey: "chat:http:owner", summary: "long", payload: { text: long } });
  store.putObject({ id: t.id, kind: "trigger", summary: t.summary, body: { text: long } });
  const rendered = renderTrigger(t, store);
  assert.match(rendered, new RegExp(`recall\\("${t.id}", offset=\\d+\\)`));
  assert.match(rendered, /^<trigger id=trg_\w+ source=chat kind=message thread=chat:http:owner/);
  const offset = Number(/offset=(\d+)/.exec(rendered)![1]);
  const next = renderRecall(store, t.id, offset);
  assert.match(next, /body: (word ){10}/);
});

test("chain of recall: each hop lists the next ids, forwards and backwards", () => {
  const store = new Store(":memory:");
  store.putObject({ id: "mkt:BTCUSDT:1h", kind: "thread", summary: "BTCUSDT 1h candle closes", body: {} });
  store.putObject({ id: "wrk_a", kind: "worker", summary: "analyse BTC breakout", body: { task: "x" }, links: ["mkt:BTCUSDT:1h"] });
  store.putObject({ id: "sig_b", kind: "signal", summary: "long BTCUSDT 1h", body: { entry: 1 }, links: ["wrk_a"], status: "open" });
  const fromSignal = renderRecall(store, "sig_b");
  assert.match(fromSignal, /links to: wrk_a - analyse BTC breakout/);
  const fromWorker = renderRecall(store, "wrk_a");
  assert.match(fromWorker, /links to: mkt:BTCUSDT:1h/);
  assert.match(fromWorker, /linked from: sig_b - long BTCUSDT 1h \(open\)/);
  assert.match(renderRecall(store, "nope"), /No object/);
});

test("large tool outputs are spilled into the object store", async () => {
  const store = new Store(":memory:");
  const big = defineTool({ name: "big", description: "big", schema: z.object({}), run: () => "x".repeat(20_000) });
  const registry = new ToolRegistry([big], store);
  const result = await registry.execute({ id: "1", name: "big", input: {} }, { sessionId: "s", role: "worker" });
  const id = /recall\("(out_\w+)"/.exec(result.content)?.[1];
  assert.ok(id);
  assert.equal((store.getObject<{ text: string }>(id!)!.body.text).length, 20_000);
  assert.ok(result.content.length < 7_000);
});
