import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { newId } from "../util/ids.js";
import { fmtPrice } from "../util/text.js";
import type { Candle, Side } from "../market/types.js";
import { checkOrder, type OrderRequest, type RiskLimits } from "./risk.js";

/**
 * Simulated broker with its own ledger (design §7.4). Like a real broker, it
 * is the source of truth for cash and positions; the agent only reads them.
 */

export interface PaperConfig {
  startingCash: number;
  feeBps: number;
  slippageBps: number;
  allowShorts: boolean;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  quantity: number;
  entryPrice: number;
  stop: number;
  target: number | null;
  riskAmount: number;
  openedAt: number;
  status: "open" | "closed";
  exitPrice: number | null;
  closedAt: number | null;
  exitReason: string | null;
  pnl: number | null;
  rMultiple: number | null;
  fees: number;
  meta: Record<string, unknown>;
}

export interface BrokerEvent {
  seq: number;
  at: number;
  kind: "opened" | "closed" | "stop_hit" | "target_hit" | "brackets_updated";
  positionId: string;
  symbol: string;
  summary: string;
  data: Record<string, unknown>;
}

export interface AccountSnapshot {
  cash: number;
  equity: number;
  dayStartEquity: number;
  dayPnl: number;
  dayPnlPct: number;
  realizedToday: number;
  unrealized: number;
  openPositions: number;
  killSwitch: boolean;
  startingCash: number;
}

export type OpenResult = { ok: true; position: Position } | { ok: false; reason: string };

const SCHEMA = `
create table if not exists account (id integer primary key check (id = 1), cash real not null, starting_cash real not null);
create table if not exists positions (
  id text primary key, symbol text not null, side text not null, quantity real not null, entry_price real not null,
  stop real not null, target real, risk_amount real not null, opened_at integer not null, status text not null,
  exit_price real, closed_at integer, exit_reason text, pnl real, r_multiple real, fees real not null, meta text not null);
create table if not exists events (
  seq integer primary key autoincrement, at integer not null, kind text not null, position_id text not null,
  symbol text not null, summary text not null, data text not null);
create table if not exists ledger_kv (key text primary key, value text not null);
`;

export class PaperBroker {
  private readonly db: DatabaseSync;
  private statements = new Map<string, StatementSync>();

  constructor(
    path: string,
    private readonly config: PaperConfig,
    private readonly limits: RiskLimits,
    private readonly allowedSymbols: string[],
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal;");
    this.db.exec(SCHEMA);
    this.stmt(`insert or ignore into account (id, cash, starting_cash) values (1, ?, ?)`).run(
      config.startingCash,
      config.startingCash,
    );
  }

  shutdown(): void {
    this.db.close();
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  // ------------------------------------------------------------------ state

  get killSwitch(): boolean {
    return this.kv("kill_switch") === "1";
  }

  setKillSwitch(on: boolean, reason: string): void {
    this.setKv("kill_switch", on ? "1" : "0");
    this.setKv("kill_switch_reason", reason);
  }

  killSwitchReason(): string {
    return this.kv("kill_switch_reason") ?? "";
  }

  private cash(): number {
    return Number((this.stmt(`select cash from account where id = 1`).get() as { cash: number }).cash);
  }

  private addCash(delta: number): void {
    this.stmt(`update account set cash = cash + ? where id = 1`).run(delta);
  }

  positions(status: "open" | "closed" | "all" = "open", limit = 200): Position[] {
    const rows =
      status === "all"
        ? this.stmt(`select * from positions order by opened_at desc limit ?`).all(limit)
        : this.stmt(`select * from positions where status = ? order by opened_at desc limit ?`).all(status, limit);
    return (rows as unknown as PositionRow[]).map(toPosition);
  }

  position(id: string): Position | undefined {
    const row = this.stmt(`select * from positions where id = ?`).get(id) as PositionRow | undefined;
    return row ? toPosition(row) : undefined;
  }

  closedSince(since: number): Position[] {
    return (this.stmt(`select * from positions where status = 'closed' and closed_at >= ? order by closed_at`).all(
      since,
    ) as unknown as PositionRow[]).map(toPosition);
  }

  events(sinceSeq: number, limit = 200): BrokerEvent[] {
    const rows = this.stmt(`select * from events where seq > ? order by seq limit ?`).all(sinceSeq, limit) as {
      seq: number;
      at: number;
      kind: BrokerEvent["kind"];
      position_id: string;
      symbol: string;
      summary: string;
      data: string;
    }[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      at: Number(r.at),
      kind: r.kind,
      positionId: r.position_id,
      symbol: r.symbol,
      summary: r.summary,
      data: JSON.parse(r.data) as Record<string, unknown>,
    }));
  }

  /** Mark to market. `prices` must cover every open position's symbol. */
  account(prices: Record<string, number>, now = Date.now()): AccountSnapshot {
    const open = this.positions("open");
    const cash = this.cash();
    let marketValue = 0;
    let unrealized = 0;
    for (const p of open) {
      const price = prices[p.symbol] ?? p.entryPrice;
      marketValue += p.side === "long" ? p.quantity * price : -p.quantity * price;
      unrealized += p.side === "long" ? (price - p.entryPrice) * p.quantity : (p.entryPrice - price) * p.quantity;
    }
    const equity = cash + marketValue;
    const day = utcDay(now);
    let dayStart = Number(this.kv(`day_start:${day}`) ?? NaN);
    if (!Number.isFinite(dayStart)) {
      dayStart = equity;
      this.setKv(`day_start:${day}`, String(equity));
    }
    const startOfDay = Date.parse(`${day}T00:00:00Z`);
    const realizedToday = this.closedSince(startOfDay).reduce((n, p) => n + (p.pnl ?? 0), 0);
    const startingCash = Number(
      (this.stmt(`select starting_cash from account where id = 1`).get() as { starting_cash: number }).starting_cash,
    );
    return {
      cash,
      equity,
      dayStartEquity: dayStart,
      dayPnl: equity - dayStart,
      dayPnlPct: dayStart > 0 ? ((equity - dayStart) / dayStart) * 100 : 0,
      realizedToday,
      unrealized,
      openPositions: open.length,
      killSwitch: this.killSwitch,
      startingCash,
    };
  }

  // --------------------------------------------------------------- trading

  open(
    req: OrderRequest & { meta?: Record<string, unknown> },
    price: number,
    prices: Record<string, number>,
    now = Date.now(),
  ): OpenResult {
    const account = this.account({ ...prices, [req.symbol]: price }, now);
    const lastStop = this.kv(`last_stop:${req.symbol}`);
    const decision = checkOrder(
      req,
      {
        price,
        equity: account.equity,
        cash: account.cash,
        dayStartEquity: account.dayStartEquity,
        openPositions: this.positions("open"),
        lastStopOutAt: lastStop ? Number(lastStop) : undefined,
        killSwitch: this.killSwitch,
        allowedSymbols: this.allowedSymbols,
        allowShorts: this.config.allowShorts,
        feeBps: this.config.feeBps,
        now,
      },
      this.limits,
    );
    if (!decision.ok) return decision;

    const slip = this.config.slippageBps / 10_000;
    const fill = req.side === "long" ? price * (1 + slip) : price * (1 - slip);
    const quantity = decision.quantity;
    const fee = quantity * fill * (this.config.feeBps / 10_000);
    const risk = Math.abs(fill - req.stop) * quantity;
    const id = newId("pos");

    this.db.exec("begin");
    try {
      this.addCash(req.side === "long" ? -(quantity * fill) - fee : quantity * fill - fee);
      this.stmt(
        `insert into positions (id, symbol, side, quantity, entry_price, stop, target, risk_amount, opened_at, status, fees, meta)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      ).run(id, req.symbol, req.side, quantity, fill, req.stop, req.target ?? null, risk, now, fee, JSON.stringify(req.meta ?? {}));
      this.emit(now, "opened", id, req.symbol, `${req.side} ${fmtQty(quantity)} ${req.symbol} @ ${fmtPrice(fill)} stop ${fmtPrice(req.stop)}${req.target ? ` target ${fmtPrice(req.target)}` : ""}`, {
        side: req.side,
        quantity,
        fill,
        stop: req.stop,
        target: req.target ?? null,
        riskAmount: risk,
        fee,
      });
      this.db.exec("commit");
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
    return { ok: true, position: this.position(id)! };
  }

  close(id: string, price: number, reason: string, now = Date.now()): Position | undefined {
    const p = this.position(id);
    if (!p || p.status !== "open") return undefined;
    const slip = reason === "stop_hit" || reason === "target_hit" ? 0 : this.config.slippageBps / 10_000;
    const exit = p.side === "long" ? price * (1 - slip) : price * (1 + slip);
    const fee = p.quantity * exit * (this.config.feeBps / 10_000);
    const gross = p.side === "long" ? (exit - p.entryPrice) * p.quantity : (p.entryPrice - exit) * p.quantity;
    const pnl = gross - fee - p.fees;
    const r = p.riskAmount > 0 ? gross / p.riskAmount : 0;

    this.db.exec("begin");
    try {
      this.addCash(p.side === "long" ? p.quantity * exit - fee : -(p.quantity * exit) - fee);
      this.stmt(
        `update positions set status = 'closed', exit_price = ?, closed_at = ?, exit_reason = ?, pnl = ?, r_multiple = ?, fees = fees + ? where id = ?`,
      ).run(exit, now, reason, pnl, r, fee, id);
      if (reason === "stop_hit") this.setKv(`last_stop:${p.symbol}`, String(now));
      const kind = reason === "stop_hit" ? "stop_hit" : reason === "target_hit" ? "target_hit" : "closed";
      this.emit(now, kind, id, p.symbol, `${p.side} ${p.symbol} closed @ ${fmtPrice(exit)} (${reason}) pnl ${pnl.toFixed(2)} (${r.toFixed(2)}R)`, {
        exit,
        reason,
        pnl,
        r,
      });
      this.db.exec("commit");
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
    return this.position(id);
  }

  updateBrackets(id: string, stop?: number, target?: number | null, now = Date.now()): { ok: boolean; reason?: string } {
    const p = this.position(id);
    if (!p || p.status !== "open") return { ok: false, reason: "position is not open" };
    const newStop = stop ?? p.stop;
    const newTarget = target === undefined ? p.target : target;
    if (p.side === "long" && newTarget !== null && newTarget <= newStop) return { ok: false, reason: "target must be above stop" };
    if (p.side === "short" && newTarget !== null && newTarget >= newStop) return { ok: false, reason: "target must be below stop" };
    this.stmt(`update positions set stop = ?, target = ? where id = ?`).run(newStop, newTarget, id);
    this.emit(now, "brackets_updated", id, p.symbol, `${p.symbol} stop ${fmtPrice(newStop)}${newTarget ? ` target ${fmtPrice(newTarget)}` : ""}`, {
      stop: newStop,
      target: newTarget,
    });
    return { ok: true };
  }

  /**
   * Check brackets against one closed 1-minute candle. Only candles that
   * opened after the entry count: the entry minute's range includes prices
   * from before the position existed. A candle touching both levels fills
   * the stop (conservative); a gap through the stop fills at the open.
   */
  onCandle(symbol: string, candle: Candle): Position[] {
    const closed: Position[] = [];
    for (const p of this.positions("open")) {
      const firstFullMinute = Math.ceil(p.openedAt / 60_000) * 60_000;
      if (p.symbol !== symbol || candle.openTime < firstFullMinute) continue;
      const stopHit = p.side === "long" ? candle.low <= p.stop : candle.high >= p.stop;
      const targetHit = p.target !== null && (p.side === "long" ? candle.high >= p.target : candle.low <= p.target);
      if (stopHit) {
        const gapped = p.side === "long" ? candle.open < p.stop : candle.open > p.stop;
        const done = this.close(p.id, gapped ? candle.open : p.stop, "stop_hit", candle.closeTime);
        if (done) closed.push(done);
      } else if (targetHit) {
        const done = this.close(p.id, p.target!, "target_hit", candle.closeTime);
        if (done) closed.push(done);
      }
    }
    return closed;
  }

  // -------------------------------------------------------------- internals

  private emit(at: number, kind: BrokerEvent["kind"], positionId: string, symbol: string, summary: string, data: object) {
    this.stmt(`insert into events (at, kind, position_id, symbol, summary, data) values (?, ?, ?, ?, ?, ?)`).run(
      at,
      kind,
      positionId,
      symbol,
      summary,
      JSON.stringify(data),
    );
  }

  private kv(key: string): string | undefined {
    const row = this.stmt(`select value from ledger_kv where key = ?`).get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setKv(key: string, value: string): void {
    this.stmt(`insert into ledger_kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`).run(
      key,
      value,
    );
  }
}

interface PositionRow {
  id: string;
  symbol: string;
  side: Side;
  quantity: number;
  entry_price: number;
  stop: number;
  target: number | null;
  risk_amount: number;
  opened_at: number;
  status: "open" | "closed";
  exit_price: number | null;
  closed_at: number | null;
  exit_reason: string | null;
  pnl: number | null;
  r_multiple: number | null;
  fees: number;
  meta: string;
}

function toPosition(r: PositionRow): Position {
  return {
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    quantity: Number(r.quantity),
    entryPrice: Number(r.entry_price),
    stop: Number(r.stop),
    target: r.target === null ? null : Number(r.target),
    riskAmount: Number(r.risk_amount),
    openedAt: Number(r.opened_at),
    status: r.status,
    exitPrice: r.exit_price === null ? null : Number(r.exit_price),
    closedAt: r.closed_at === null ? null : Number(r.closed_at),
    exitReason: r.exit_reason,
    pnl: r.pnl === null ? null : Number(r.pnl),
    rMultiple: r.r_multiple === null ? null : Number(r.r_multiple),
    fees: Number(r.fees),
    meta: JSON.parse(r.meta) as Record<string, unknown>,
  };
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtQty(q: number): string {
  return Number(q.toPrecision(6)).toString();
}
