import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Runtime } from "../src/runtime.js";
import { Store } from "../src/state/store.js";
import { ExecutionEndpoint } from "../src/endpoint/endpoint.js";
import { LocalEndpointClient } from "../src/endpoint/client.js";
import { MockLlm } from "../src/llm/mock.js";
import { buildWorkerTools } from "../src/workers/tools.js";
import type { Config, LlmRole } from "../src/config.js";
import { CaptureChannel, FixedMarket, settle, testConfig, trendCandles } from "./helpers.js";

const TF = 900_000;

function build(config: Config, opts: { store?: Store; endpoint?: ExecutionEndpoint; market?: FixedMarket } = {}) {
  const market = opts.market ?? new FixedMarket();
  const endpoint =
    opts.endpoint ??
    new ExecutionEndpoint({
      marketDataUrl: "",
      ledgerPath: ":memory:",
      symbols: config.symbols,
      paper: config.paper,
      risk: config.risk,
      market,
    });
  const capture = new CaptureChannel();
  const llms = new Map<LlmRole, MockLlm>();
  const rt = new Runtime(config, {
    store: opts.store ?? new Store(":memory:"),
    endpoint: new LocalEndpointClient(endpoint),
    channels: [capture],
    feed: false,
    watchdogTimer: false,
    brokerPollMs: 3_600_000,
    llmFactory: (role) => {
      const llm = new MockLlm(role, config);
      llms.set(role, llm);
      return llm;
    },
  });
  return { rt, capture, market, endpoint, llms };
}

/** Prime the feed with a quiet history, then deliver one new breakout candle. */
async function breakout(rt: Runtime, market: FixedMarket, symbol = "BTCUSDT") {
  const all = trendCandles(301, TF, { breakout: true });
  market.set(symbol, "15m", all.slice(0, 300));
  rt.feed.process(symbol, "15m", all.slice(0, 300)); // first sight: emits nothing
  market.set(symbol, "15m", all);
  rt.feed.process(symbol, "15m", all);
  await settle(rt);
  return all;
}

test("signals mode: candle close -> filter -> router -> worker -> signal -> notification", async () => {
  const { rt, capture, market, llms } = build(testConfig({ BOT_MODE: "signals" }));
  await rt.start();
  await breakout(rt, market);

  const signals = rt.signals.open();
  assert.equal(signals.length, 1, "one signal recorded");
  assert.match(signals[0].summary, /^long BTCUSDT 15m/);
  const notice = capture.sent.find((m) => /NEW SIGNAL/.test(m.text));
  assert.ok(notice, `expected a signal notification, got ${JSON.stringify(capture.sent)}`);
  assert.match(notice.text, /LONG BTCUSDT 15m entry/);

  // The setup went through both filter stages and was escalated.
  const escalated = rt.store.listObjects("trigger", { status: "escalated" });
  assert.equal(escalated.length, 1);
  // Router stayed coordination-only: it dispatched, it never touched market data.
  const routerTools = llms.get("router")!.requests[0].tools.map((t) => t.name);
  assert.ok(routerTools.includes("dispatch_worker"));
  assert.ok(!routerTools.some((n) => /market|candles|order/.test(n)));
  // The worker finished and released its slot.
  assert.equal(rt.pool.list(0).length, 0);
  await rt.stop();
});

test("signals mode registers no order tools at all", async () => {
  const { rt, market, llms } = build(testConfig({ BOT_MODE: "signals" }));
  await rt.start();
  await breakout(rt, market);
  const workerTools = llms.get("worker")!.requests[0].tools.map((t) => t.name);
  assert.ok(workerTools.includes("propose_signal"));
  assert.ok(!workerTools.includes("place_paper_order"));
  await rt.stop();
});

test("autonomous mode: opens a paper position, the bracket stop closes it, the worker finishes", async () => {
  const { rt, capture, market, endpoint } = build(testConfig({ BOT_MODE: "autonomous" }));
  await rt.start();
  await breakout(rt, market);

  const [position] = endpoint.broker.positions("open");
  assert.ok(position, "a paper position was opened");
  assert.equal(position.side, "long");
  assert.ok(capture.sent.some((m) => /OPENED pos_/.test(m.text)), "owner notified of the entry");
  const owner = String(position.meta.workerId);
  assert.ok(rt.threads.subscribers(`pos:${position.id}`).includes(owner), "worker owns the position thread");

  // Price falls through the stop on the next minute.
  const minute = Math.ceil(position.openedAt / 60_000) * 60_000;
  endpoint.broker.onCandle("BTCUSDT", {
    openTime: minute,
    closeTime: minute + 59_999,
    open: position.entryPrice,
    high: position.entryPrice,
    low: position.stop * 0.99,
    close: position.stop * 0.995,
    volume: 1,
  });
  await rt.pollBroker();
  await settle(rt);

  assert.equal(endpoint.broker.position(position.id)!.exitReason, "stop_hit");
  assert.equal(rt.store.getSession(owner)!.status, "done", "worker finished after its position closed");
  assert.equal(rt.threads.subscribers(`pos:${position.id}`).length, 0);
  await rt.stop();
});

test("moving a bracket keeps the recallable position in step with the broker", async () => {
  const { rt, market, endpoint } = build(testConfig({ BOT_MODE: "autonomous" }));
  await rt.start();
  await breakout(rt, market);
  const [position] = endpoint.broker.positions("open");
  const owner = String(position.meta.workerId);
  const target = position.target! * 1.01;
  const tools = buildWorkerTools(rt, owner, "task");
  const result = await tools.execute({ id: "1", name: "update_brackets", input: { position_id: position.id, target } }, { sessionId: owner, role: "worker" });
  assert.equal(result.content, "Brackets updated.");
  const stored = rt.store.getObject<{ target: number }>(position.id)!;
  assert.equal(stored.body.target, target);
  assert.match(stored.summary, new RegExp(`target ${String(Number(target.toFixed(4))).slice(0, 5)}`));
  await rt.stop();
});

test("restart: a worker holding a position resumes from the store and still handles its stop", async () => {
  const config = testConfig({ BOT_MODE: "autonomous" });
  const store = new Store(join(config.dataDir, "agent.db"));
  const first = build(config, { store });
  await first.rt.start();
  await breakout(first.rt, first.market);
  const [position] = first.endpoint.broker.positions("open");
  assert.ok(position);
  const owner = String(position.meta.workerId);
  await first.rt.stop(); // process "dies"

  // New process: same state store, same broker (the endpoint outlives the agent).
  const second = build(config, { store, endpoint: first.endpoint, market: first.market });
  await second.rt.start();
  await settle(second.rt);
  assert.ok(second.rt.pool.get(owner), "worker rebuilt from the store");
  assert.ok(second.rt.threads.subscribers(`pos:${position.id}`).includes(owner), "subscription survived");

  const minute = Math.ceil(position.openedAt / 60_000) * 60_000;
  first.endpoint.broker.onCandle("BTCUSDT", {
    openTime: minute,
    closeTime: minute + 59_999,
    open: position.entryPrice,
    high: position.entryPrice,
    low: position.stop * 0.99,
    close: position.stop,
    volume: 1,
  });
  await second.rt.pollBroker();
  await settle(second.rt);
  assert.equal(store.getSession(owner)!.status, "done");
  await second.rt.stop();
});

test("chat: an explicit message gets a reply on its channel; /watchdog goes to the watchdog", async () => {
  const { rt, capture } = build(testConfig());
  await rt.start();
  rt.ingestChat({ channel: "console", conversation: "owner", author: "owner", text: "how are we doing?", explicit: true, isGroup: false, allowed: true });
  await settle(rt);
  assert.ok(capture.sent.some((m) => m.text === "Got it. On it."));
  rt.ingestChat({ channel: "console", conversation: "owner", author: "owner", text: "/watchdog status", explicit: true, isGroup: false, allowed: true });
  await settle(rt);
  assert.ok(capture.sent.some((m) => m.text === "Watchdog: systems checked."));
  await rt.stop();
});

test("daily digest: scheduled trigger -> digest worker -> notification", async () => {
  const { rt, capture } = build(testConfig());
  await rt.start();
  rt.digest.fire("2026-11-03");
  await settle(rt);
  assert.ok(capture.sent.some((m) => /Daily digest/i.test(m.text)), JSON.stringify(capture.sent));
  rt.digest.fire("2026-11-03");
  await settle(rt);
  assert.equal(capture.sent.filter((m) => /Daily digest/i.test(m.text)).length, 1, "the same day is never sent twice");
  await rt.stop();
});

test("IM messages over the word limit are rejected so the model must shorten them", async () => {
  const { rt } = build(testConfig({ IM_WORD_LIMIT: "5" }));
  await rt.start();
  await assert.rejects(rt.hub.send("console", "one two three four five six"), /allows at most 5/);
  await rt.stop();
});

test("watchdog: the daily loss limit turns the kill switch on in code", async () => {
  const { rt, capture, endpoint } = build(testConfig({ BOT_MODE: "autonomous" }));
  await rt.start();
  // Each trade risks 0.5%; book losing trades until the day is down 3%. The risk
  // guard itself refuses new entries once the limit is reached.
  let rejected = "";
  for (let i = 0; i < 10 && !rejected; i++) {
    const r = endpoint.broker.open({ symbol: "ETHUSDT", side: "long", stop: 90 }, 100, {});
    if (!r.ok) rejected = r.reason;
    else endpoint.broker.close(r.position.id, 70, "manual");
  }
  assert.match(rejected, /daily loss limit/);
  assert.ok(endpoint.broker.account({}).dayPnlPct <= -3);
  const findings = await rt.watchdog.tick();
  assert.ok(findings.some((f) => /kill switch turned ON/.test(f)));
  assert.equal(endpoint.broker.killSwitch, true);
  assert.ok(capture.sent.some((m) => /Kill switch ON/.test(m.text)));
  await rt.stop();
});
