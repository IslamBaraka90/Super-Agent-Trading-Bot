import { z } from "zod";
import { ToolRegistry, defineTool, type AnyTool } from "../agent/tools.js";
import { recallTool } from "../agent/common-tools.js";
import { TIMEFRAMES, type Timeframe } from "../config.js";
import { analyze, DETECTORS, MIN_BARS } from "../market/detectors.js";
import { backtestDetector } from "../market/backtest.js";
import type { Candle } from "../market/types.js";
import { TF_MS, marketThread } from "../market/types.js";
import { makeTrigger, type Trigger } from "../events/trigger.js";
import type { Runtime } from "../runtime.js";
import { oneLine, fmtPrice } from "../util/text.js";

export type WorkerKind = "task" | "speculative";

const r6 = (x: number) => (Number.isFinite(x) ? Number(x.toPrecision(6)) : x);

const THREAD_RE = /^(mkt:[A-Z0-9]+:[0-9]+[mhdw]|pos:pos_[a-z0-9]+|sys:endpoint|job:job_[a-z0-9]+)$/;

export function validThread(rt: Runtime, key: string): string | undefined {
  if (!THREAD_RE.test(key)) return `"${key}" is not a thread key (mkt:SYMBOL:TF, pos:pos_..., job:job_..., sys:endpoint)`;
  if (key.startsWith("mkt:")) {
    const [, symbol, tf] = key.split(":");
    if (!rt.config.symbols.includes(symbol)) return `${symbol} is not in SYMBOLS`;
    if (!(TIMEFRAMES as readonly string[]).includes(tf)) return `${tf} is not a supported timeframe`;
  }
  return undefined;
}

export function buildWorkerTools(rt: Runtime, workerId: string, kind: WorkerKind): ToolRegistry {
  // A transform would not survive export to JSON Schema, so the format is validated instead.
  const symbolSchema = z.string().regex(/^[A-Z0-9]+$/, "use the uppercase exchange symbol, e.g. BTCUSDT");
  const tfSchema = z.enum(TIMEFRAMES);

  const candles = async (symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> => {
    if (!rt.config.symbols.includes(symbol)) throw new Error(`${symbol} is not in SYMBOLS (${rt.config.symbols.join(", ")})`);
    return rt.endpoint.call<Candle[]>("market.candles", { symbol, interval: timeframe, limit });
  };

  const snapshot = defineTool({
    name: "market_snapshot",
    description:
      "Latest closed candles, indicators (EMA20/50/200, RSI, ATR, Bollinger, Donchian, volume z) and active setups for one symbol and timeframe.",
    schema: z.object({ symbol: symbolSchema, timeframe: tfSchema }),
    run: async ({ symbol, timeframe }) => {
      const data = await candles(symbol, timeframe, 300);
      const analysis = analyze(data, { targetR: rt.config.targetR, nearAtr: rt.config.nearSetupAtr });
      if (!analysis) return `Only ${data.length} closed candles; need ${MIN_BARS} for indicators.`;
      const s = analysis.snapshot;
      return {
        symbol,
        timeframe,
        lastClose: new Date(analysis.candle.closeTime).toISOString().slice(0, 16) + "Z",
        indicators: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === "number" ? r6(v) : v])),
        setups: analysis.setups.map((x) => ({ ...x, entry: r6(x.entry), stop: r6(x.stop), target: r6(x.target), atr: r6(x.atr) })),
        nearSetups: analysis.near.map((x) => ({ ...x, level: r6(x.level), distanceAtr: r6(x.distanceAtr) })),
        last5: data.slice(-5).map((c) => [new Date(c.openTime).toISOString().slice(5, 16), c.open, c.high, c.low, c.close, r6(c.volume)]),
      };
    },
  });

  const getCandles = defineTool({
    name: "get_candles",
    description: "Raw closed OHLCV candles as CSV (time,open,high,low,close,volume), oldest first.",
    schema: z.object({ symbol: symbolSchema, timeframe: tfSchema, limit: z.number().int().min(5).max(500).optional() }),
    run: async ({ symbol, timeframe, limit }) => {
      const data = await candles(symbol, timeframe, limit ?? 100);
      return ["time,open,high,low,close,volume", ...data.map((c) => `${new Date(c.openTime).toISOString().slice(0, 16)},${c.open},${c.high},${c.low},${c.close},${r6(c.volume)}`)].join("\n");
    },
  });

  const startBacktest = defineTool({
    name: "start_backtest",
    description:
      "Start a background backtest of a detector on recent history. Returns a job id at once; the result arrives later as a job_done event.",
    schema: z.object({
      symbol: symbolSchema,
      timeframe: tfSchema,
      detector: z.enum([...DETECTORS, "all"]),
      bars: z.number().int().min(300).max(5000).optional(),
      side: z.enum(["long", "short"]).optional(),
    }),
    run: ({ symbol, timeframe, detector, bars, side }) => {
      if (!rt.config.symbols.includes(symbol)) throw new Error(`${symbol} is not in SYMBOLS`);
      const id = rt.jobs.start(workerId, "backtest", { symbol, timeframe, detector, bars: bars ?? 1500, side }, async (signal) => {
        const history = await rt.endpoint.call<Candle[]>("market.history", { symbol, interval: timeframe, total: bars ?? 1500 });
        return backtestDetector(history, detector, { targetR: rt.config.targetR, side, signal });
      });
      return `Started ${id}. Its result will arrive as a job_done event; continue or end your turn.`;
    },
  });

  const stopJob = defineTool({
    name: "stop_job",
    description: "Cancel one of your background jobs.",
    schema: z.object({ job_id: z.string() }),
    run: ({ job_id }) => (rt.jobs.stop(job_id) ? `Cancelling ${job_id}.` : `${job_id} is not running.`),
  });

  const subscribe = defineTool({
    name: "subscribe_thread",
    description: "Receive every event of a thread (mkt:SYMBOL:TF candle closes, pos:ID position events, sys:endpoint).",
    schema: z.object({ thread: z.string() }),
    run: ({ thread }) => {
      const problem = validThread(rt, thread);
      if (problem) throw new Error(problem);
      rt.threads.subscribe(thread, workerId);
      rt.store.updateObject(workerId, { links: [thread] });
      return `Subscribed to ${thread}.`;
    },
  });

  const unsubscribe = defineTool({
    name: "unsubscribe_thread",
    description: "Stop receiving a thread's events.",
    schema: z.object({ thread: z.string() }),
    run: ({ thread }) => {
      rt.threads.unsubscribe(thread, workerId);
      return `Unsubscribed from ${thread}.`;
    },
  });

  const finish = defineTool({
    name: "finish",
    description:
      kind === "speculative"
        ? "End the pre-analysis and store it. Under 120 words."
        : "End your task. The summary goes to the Router. Positions you opened must be closed first.",
    schema: z.object({ summary: z.string().min(1) }),
    run: async ({ summary }) => {
      if (kind === "task" && rt.config.mode === "autonomous") {
        const open = await rt.endpoint.call<{ id: string; meta: Record<string, unknown> }[]>("broker.positions", { status: "open" });
        const mine = open.filter((p) => p.meta?.workerId === workerId);
        if (mine.length) {
          throw new Error(`You still hold ${mine.map((p) => p.id).join(", ")}. Close or hand them over (report) before finishing.`);
        }
      }
      rt.pool.complete(workerId, summary, kind);
      return "Task finished.";
    },
  });

  const tools: AnyTool[] = [snapshot, getCandles, startBacktest, stopJob, recallTool(rt), finish];
  if (kind === "speculative") return new ToolRegistry(tools, rt.store);

  const report = defineTool({
    name: "report",
    description: "Send the Router a short factual update. It decides whether people hear about it.",
    schema: z.object({ text: z.string().min(1) }),
    run: ({ text }) => {
      rt.pool.report(workerId, text, false);
      return "Reported.";
    },
  });

  const handback = defineTool({
    name: "handback",
    description: "Hand an event you received back to the Router because it is outside your task.",
    schema: z.object({ trigger_id: z.string(), note: z.string() }),
    run: ({ trigger_id, note }) => {
      const obj = rt.store.getObject(trigger_id);
      if (!obj || obj.kind !== "trigger") throw new Error(`No trigger ${trigger_id}`);
      const original = obj.body as unknown as Trigger;
      rt.router.submit({ ...original, summary: `${obj.summary} [handed back by ${workerId}: ${oneLine(note, 100)}]` });
      return "Handed back to the Router.";
    },
  });

  const account = defineTool({
    name: "account",
    description: "Paper account: equity, cash, today's P&L, open position count, kill switch.",
    schema: z.object({}),
    run: () => rt.endpoint.call("broker.account"),
  });

  const positions = defineTool({
    name: "positions",
    description: "Open paper positions with mark price and unrealized P&L.",
    schema: z.object({}),
    run: () => rt.endpoint.call("broker.positions", { status: "open" }),
  });

  const scorecard = defineTool({
    name: "scorecard",
    description: "Signal scorecard and paper trading results over the last N days.",
    schema: z.object({ days: z.number().min(0.1).max(90).optional() }),
    run: async ({ days }) => {
      const since = Date.now() - (days ?? 1) * 86_400_000;
      const trades = await rt.endpoint.call<{ symbol: string; side: string; pnl: number; rMultiple: number; exitReason: string }[]>(
        "broker.closedSince",
        { since },
      );
      const pnl = trades.reduce((n, t) => n + (t.pnl ?? 0), 0);
      return {
        signals: rt.signals.scorecard(since),
        paperTrades: {
          closed: trades.length,
          wins: trades.filter((t) => t.pnl > 0).length,
          pnl: Number(pnl.toFixed(2)),
          list: trades.slice(0, 20).map((t) => `${t.side} ${t.symbol} ${t.exitReason} ${t.rMultiple?.toFixed(2)}R pnl ${t.pnl?.toFixed(2)}`),
        },
      };
    },
  });

  const activity = defineTool({
    name: "activity",
    description: "What the bot saw and did over the last N hours: events by outcome, escalated setups, signals, workers.",
    schema: z.object({ hours: z.number().min(1).max(168).optional() }),
    run: ({ hours }) => {
      const since = Date.now() - (hours ?? 24) * 3_600_000;
      const escalated = rt.store
        .listObjects("trigger", { status: "escalated", since, limit: 30 })
        .map((o) => `${o.id} ${oneLine(o.summary, 100)}`);
      const signals = rt.store.listObjects("signal", { since, limit: 30 }).map((o) => `${o.id} [${o.status}] ${oneLine(o.summary, 100)}`);
      const workers = rt.store.listObjects("worker", { since, limit: 30 }).map((o) => `${o.id} [${o.status}] ${oneLine(o.summary, 80)}`);
      return { eventsByOutcome: rt.store.triggerCounts(since), escalated, signals, workers };
    },
  });

  tools.push(report, handback, subscribe, unsubscribe, account, positions, scorecard, activity);

  if (rt.config.mode === "signals") {
    const proposeSignal = defineTool({
      name: "propose_signal",
      description:
        "Record a trading signal. It is tracked against later candles (target, stop or expiry) and sent to the Router for notification.",
      schema: z.object({
        symbol: symbolSchema,
        timeframe: tfSchema,
        side: z.enum(["long", "short"]),
        entry: z.number().positive(),
        stop: z.number().positive(),
        target: z.number().positive(),
        confidence: z.number().min(0).max(1),
        rationale: z.string().min(10),
        valid_for_bars: z.number().int().min(1).max(200).optional(),
        trigger_id: z.string().optional(),
      }),
      run: (input) => {
        const { side, entry, stop, target } = input;
        if (!rt.config.timeframes.includes(input.timeframe)) {
          throw new Error(`Signals are tracked on the polled timeframes only: ${rt.config.timeframes.join(", ")}`);
        }
        if (side === "long" && !(stop < entry && target > entry)) throw new Error("long: stop must be below entry and target above it");
        if (side === "short" && !(stop > entry && target < entry)) throw new Error("short: stop must be above entry and target below it");
        const signal = rt.signals.create({
          ...input,
          workerId,
          expiresAt: Date.now() + (input.valid_for_bars ?? 24) * TF_MS[input.timeframe],
        });
        rt.pool.report(
          workerId,
          `NEW SIGNAL ${signal.id}: ${side.toUpperCase()} ${input.symbol} ${input.timeframe} entry ${fmtPrice(entry)} stop ${fmtPrice(stop)} ` +
            `target ${fmtPrice(target)} confidence ${Math.round(input.confidence * 100)}%. ${oneLine(input.rationale, 200)}`,
          false,
          [signal.id],
        );
        return `Signal ${signal.id} recorded and sent to the Router.`;
      },
    });
    tools.push(proposeSignal);
  } else {
    const placeOrder = defineTool({
      name: "place_paper_order",
      description:
        "Open a PAPER position at market with a mandatory stop (and optional target). Size from risk_pct (default: the configured maximum) or give quantity.",
      schema: z.object({
        symbol: symbolSchema,
        side: z.enum(["long", "short"]),
        stop: z.number().positive(),
        target: z.number().positive().optional(),
        risk_pct: z.number().positive().optional(),
        quantity: z.number().positive().optional(),
        timeframe: tfSchema.optional(),
        rationale: z.string().min(10),
      }),
      run: async (input) => {
        const result = await rt.endpoint.call<
          { ok: true; position: { id: string; entryPrice: number; quantity: number; riskAmount: number } } | { ok: false; reason: string }
        >("broker.open", {
          symbol: input.symbol,
          side: input.side,
          stop: input.stop,
          target: input.target,
          riskPct: input.risk_pct,
          quantity: input.quantity,
          meta: { workerId, rationale: input.rationale, timeframe: input.timeframe ?? null },
        });
        if (!result.ok) return `REJECTED by the risk guard: ${result.reason}`;
        const p = result.position;
        const thread = `pos:${p.id}`;
        rt.store.putObject({
          id: p.id,
          kind: "position",
          summary: positionSummary(input.side, input.symbol, p.entryPrice, input.stop, input.target),
          body: { ...p, rationale: input.rationale },
          links: [workerId, thread, ...(input.timeframe ? [marketThread(input.symbol, input.timeframe)] : [])],
          status: "open",
        });
        rt.threads.subscribe(thread, workerId);
        if (input.timeframe) rt.threads.subscribe(marketThread(input.symbol, input.timeframe), workerId);
        rt.pool.report(
          workerId,
          `OPENED ${p.id}: ${input.side.toUpperCase()} ${input.symbol} qty ${Number(p.quantity.toPrecision(6))} @ ${fmtPrice(p.entryPrice)} ` +
            `stop ${fmtPrice(input.stop)}${input.target ? ` target ${fmtPrice(input.target)}` : ""} risk ${p.riskAmount.toFixed(2)}. ${oneLine(input.rationale, 160)}`,
          false,
          [p.id],
        );
        return {
          ...p,
          note: `The Router already has this entry, so do not report it. You are now subscribed to ${thread}${input.timeframe ? ` and ${marketThread(input.symbol, input.timeframe)}` : ""}.`,
        };
      },
    });

    const updateBrackets = defineTool({
      name: "update_brackets",
      description: "Move the stop and/or target of an open paper position.",
      schema: z.object({ position_id: z.string(), stop: z.number().positive().optional(), target: z.number().positive().optional() }),
      run: async ({ position_id, stop, target }) => {
        const result = await rt.endpoint.call<{ ok: boolean; reason?: string }>("broker.updateBrackets", { id: position_id, stop, target });
        if (!result.ok) return `Not updated: ${result.reason}`;
        // Keep the recallable object in step with the broker, or later readers see the old levels.
        const p = await rt.endpoint.call<{ side: string; symbol: string; entryPrice: number; stop: number; target: number | null } | null>(
          "broker.position",
          { id: position_id },
        );
        if (p) {
          rt.store.updateObject<Record<string, unknown>>(position_id, {
            summary: positionSummary(p.side, p.symbol, p.entryPrice, p.stop, p.target),
            body: { stop: p.stop, target: p.target },
          });
        }
        return "Brackets updated.";
      },
    });

    const closePosition = defineTool({
      name: "close_position",
      description: "Close an open paper position at market.",
      schema: z.object({ position_id: z.string(), reason: z.string() }),
      run: async ({ position_id, reason }) => {
        const result = await rt.endpoint.call<{ ok: boolean; reason?: string; position?: Record<string, unknown> }>("broker.close", {
          id: position_id,
          reason,
        });
        return result.ok ? result.position : `Not closed: ${result.reason}`;
      },
    });
    tools.push(placeOrder, updateBrackets, closePosition);
  }

  return new ToolRegistry(tools, rt.store);
}

function positionSummary(side: string, symbol: string, entry: number, stop: number, target?: number | null): string {
  return `${side} ${symbol} @ ${fmtPrice(entry)} stop ${fmtPrice(stop)}${target ? ` target ${fmtPrice(target)}` : ""}`;
}

export function describeTask(req: { task: string; symbol?: string; timeframe?: string }): string {
  const scope = [req.symbol, req.timeframe].filter(Boolean).join(" ");
  return `${scope ? `[${scope}] ` : ""}${req.task}`;
}

export const makeReportTrigger = (workerId: string, text: string, final: boolean, links: string[] = []) =>
  makeTrigger({
    source: "worker",
    kind: "report",
    threadKey: `wrk:${workerId}`,
    summary: `${workerId}${final ? " (finished)" : ""}: ${oneLine(text, 240)}`,
    payload: { workerId, text, final },
    links: [workerId, ...links],
  });
