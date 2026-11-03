import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatMessage } from "../llm/types.js";

/**
 * The agent's persistent state (design §5.1). The agent process keeps nothing
 * it cannot rebuild from here: kill it at any moment and restart it.
 */

export interface StoredObject<T = Record<string, unknown>> {
  id: string;
  kind: string;
  summary: string;
  body: T;
  links: string[];
  status: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionRow {
  id: string;
  role: string;
  status: string;
  epoch: number;
  task: string | null;
  model: string | null;
  meta: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  lastProgressAt: number;
  errorCount: number;
}

export interface JobRow {
  id: string;
  owner: string;
  kind: string;
  status: string;
  params: Record<string, unknown>;
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

const SCHEMA = `
create table if not exists objects (
  id text primary key, kind text not null, summary text not null, body text not null,
  links text not null default '[]', status text, created_at integer not null, updated_at integer not null);
create index if not exists objects_kind on objects(kind, status, updated_at);
create table if not exists triggers (
  id text primary key, thread text not null, status text not null, route text, note text, created_at integer not null);
create index if not exists triggers_status on triggers(status, created_at);
create table if not exists subscriptions (
  thread text not null, session_id text not null, created_at integer not null, primary key (thread, session_id));
create index if not exists subscriptions_session on subscriptions(session_id);
create table if not exists sessions (
  id text primary key, role text not null, status text not null, epoch integer not null default 0,
  task text, model text, meta text not null default '{}', created_at integer not null, updated_at integer not null,
  last_progress_at integer not null, error_count integer not null default 0);
create table if not exists messages (
  session_id text not null, epoch integer not null, seq integer not null, message text not null,
  created_at integer not null, primary key (session_id, epoch, seq));
create table if not exists jobs (
  id text primary key, owner text not null, kind text not null, status text not null, params text not null,
  result text, created_at integer not null, updated_at integer not null);
create table if not exists kv (key text primary key, value text not null);
`;

export class Store {
  readonly db: DatabaseSync;
  private statements = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal; pragma synchronous = normal;");
    this.db.exec(SCHEMA);
  }

  close(): void {
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

  // ---------------------------------------------------------------- objects

  putObject<T extends object>(obj: {
    id: string;
    kind: string;
    summary: string;
    body: T;
    links?: string[];
    status?: string | null;
  }): StoredObject<T> {
    const now = Date.now();
    const existing = this.getObject(obj.id);
    const createdAt = existing?.createdAt ?? now;
    this.stmt(
      `insert into objects (id, kind, summary, body, links, status, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set kind = excluded.kind, summary = excluded.summary, body = excluded.body,
         links = excluded.links, status = excluded.status, updated_at = excluded.updated_at`,
    ).run(
      obj.id,
      obj.kind,
      obj.summary,
      JSON.stringify(obj.body),
      JSON.stringify(dedupe(obj.links ?? [])),
      obj.status ?? null,
      createdAt,
      now,
    );
    return {
      id: obj.id,
      kind: obj.kind,
      summary: obj.summary,
      body: obj.body,
      links: dedupe(obj.links ?? []),
      status: obj.status ?? null,
      createdAt,
      updatedAt: now,
    };
  }

  /** Merge a patch into an existing object. Links are unioned. */
  updateObject<T extends object>(
    id: string,
    patch: { summary?: string; body?: Partial<T>; links?: string[]; status?: string | null },
  ): StoredObject<T> | undefined {
    const current = this.getObject<T>(id);
    if (!current) return undefined;
    return this.putObject<T>({
      id,
      kind: current.kind,
      summary: patch.summary ?? current.summary,
      body: { ...current.body, ...(patch.body ?? {}) } as T,
      links: [...current.links, ...(patch.links ?? [])],
      status: patch.status === undefined ? current.status : patch.status,
    });
  }

  getObject<T = Record<string, unknown>>(id: string): StoredObject<T> | undefined {
    const row = this.stmt(`select * from objects where id = ?`).get(id) as ObjectRow | undefined;
    return row ? toObject<T>(row) : undefined;
  }

  listObjects<T = Record<string, unknown>>(
    kind: string,
    opts: { status?: string | string[]; since?: number; limit?: number } = {},
  ): StoredObject<T>[] {
    const where = ["kind = ?"];
    const args: (string | number)[] = [kind];
    if (opts.status !== undefined) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      where.push(`status in (${statuses.map(() => "?").join(",")})`);
      args.push(...statuses);
    }
    if (opts.since !== undefined) {
      where.push("updated_at >= ?");
      args.push(opts.since);
    }
    const sql = `select * from objects where ${where.join(" and ")} order by updated_at desc limit ${opts.limit ?? 500}`;
    return (this.db.prepare(sql).all(...args) as unknown as ObjectRow[]).map((r) => toObject<T>(r));
  }

  /** Objects that link to `id` (reverse edges of the reference graph). */
  backlinks(id: string, limit = 20): StoredObject[] {
    const rows = this.stmt(
      `select * from objects where links like ? order by updated_at desc limit ?`,
    ).all(`%"${id}"%`, limit) as unknown as ObjectRow[];
    return rows.map((r) => toObject(r));
  }

  // --------------------------------------------------------------- triggers

  recordTrigger(id: string, thread: string, status: string, route?: string, note?: string): void {
    this.stmt(
      `insert into triggers (id, thread, status, route, note, created_at) values (?, ?, ?, ?, ?, ?)
       on conflict(id) do update set status = excluded.status, route = excluded.route, note = excluded.note`,
    ).run(id, thread, status, route ?? null, note ?? null, Date.now());
  }

  setTriggerStatus(id: string, status: string, note?: string): void {
    this.stmt(`update triggers set status = ?, note = coalesce(?, note) where id = ?`).run(status, note ?? null, id);
  }

  triggersWithStatus(status: string, route?: string): { id: string; thread: string; route: string | null }[] {
    const sql = route
      ? `select id, thread, route from triggers where status = ? and route = ? order by created_at`
      : `select id, thread, route from triggers where status = ? order by created_at`;
    const rows = route ? this.stmt(sql).all(status, route) : this.stmt(sql).all(status);
    return rows as { id: string; thread: string; route: string | null }[];
  }

  triggerCounts(since: number): Record<string, number> {
    const rows = this.stmt(`select status, count(*) as n from triggers where created_at >= ? group by status`).all(
      since,
    ) as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  // ---------------------------------------------------------- subscriptions

  subscribe(thread: string, sessionId: string): void {
    this.stmt(`insert or ignore into subscriptions (thread, session_id, created_at) values (?, ?, ?)`).run(
      thread,
      sessionId,
      Date.now(),
    );
  }

  unsubscribe(thread: string, sessionId: string): void {
    this.stmt(`delete from subscriptions where thread = ? and session_id = ?`).run(thread, sessionId);
  }

  unsubscribeAll(sessionId: string): void {
    this.stmt(`delete from subscriptions where session_id = ?`).run(sessionId);
  }

  subscribers(thread: string): string[] {
    return (this.stmt(`select session_id from subscriptions where thread = ?`).all(thread) as { session_id: string }[]).map(
      (r) => r.session_id,
    );
  }

  threadsOf(sessionId: string): string[] {
    return (this.stmt(`select thread from subscriptions where session_id = ?`).all(sessionId) as { thread: string }[]).map(
      (r) => r.thread,
    );
  }

  // --------------------------------------------------------------- sessions

  createSession(row: { id: string; role: string; status: string; task?: string; model?: string; meta?: object }): void {
    const now = Date.now();
    this.stmt(
      `insert into sessions (id, role, status, epoch, task, model, meta, created_at, updated_at, last_progress_at)
       values (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.role, row.status, row.task ?? null, row.model ?? null, JSON.stringify(row.meta ?? {}), now, now, now);
  }

  getSession(id: string): SessionRow | undefined {
    const row = this.stmt(`select * from sessions where id = ?`).get(id) as RawSession | undefined;
    return row ? toSession(row) : undefined;
  }

  listSessions(opts: { role?: string; status?: string[] } = {}): SessionRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.role) {
      where.push("role = ?");
      args.push(opts.role);
    }
    if (opts.status?.length) {
      where.push(`status in (${opts.status.map(() => "?").join(",")})`);
      args.push(...opts.status);
    }
    const sql = `select * from sessions ${where.length ? "where " + where.join(" and ") : ""} order by created_at`;
    return (this.db.prepare(sql).all(...args) as unknown as RawSession[]).map(toSession);
  }

  updateSession(
    id: string,
    patch: { status?: string; epoch?: number; meta?: Record<string, unknown>; progress?: boolean; error?: boolean },
  ): void {
    const current = this.getSession(id);
    if (!current) return;
    const now = Date.now();
    this.stmt(
      `update sessions set status = ?, epoch = ?, meta = ?, updated_at = ?, last_progress_at = ?, error_count = ? where id = ?`,
    ).run(
      patch.status ?? current.status,
      patch.epoch ?? current.epoch,
      JSON.stringify(patch.meta ? { ...current.meta, ...patch.meta } : current.meta),
      now,
      patch.progress ? now : current.lastProgressAt,
      patch.error ? current.errorCount + 1 : patch.progress ? 0 : current.errorCount,
      id,
    );
  }

  // --------------------------------------------------------------- messages

  /** Append-only: there is deliberately no update or delete for messages. */
  appendMessage(sessionId: string, epoch: number, message: ChatMessage): void {
    const row = this.stmt(`select coalesce(max(seq), -1) as seq from messages where session_id = ? and epoch = ?`).get(
      sessionId,
      epoch,
    ) as { seq: number };
    this.stmt(`insert into messages (session_id, epoch, seq, message, created_at) values (?, ?, ?, ?, ?)`).run(
      sessionId,
      epoch,
      Number(row.seq) + 1,
      JSON.stringify(message),
      Date.now(),
    );
  }

  loadMessages(sessionId: string, epoch: number): ChatMessage[] {
    const rows = this.stmt(`select message from messages where session_id = ? and epoch = ? order by seq`).all(
      sessionId,
      epoch,
    ) as { message: string }[];
    return rows.map((r) => JSON.parse(r.message) as ChatMessage);
  }

  // ------------------------------------------------------------------- jobs

  createJob(job: { id: string; owner: string; kind: string; params: object }): void {
    const now = Date.now();
    this.stmt(
      `insert into jobs (id, owner, kind, status, params, created_at, updated_at) values (?, ?, ?, 'running', ?, ?, ?)`,
    ).run(job.id, job.owner, job.kind, JSON.stringify(job.params), now, now);
  }

  updateJob(id: string, status: string, result?: string): void {
    this.stmt(`update jobs set status = ?, result = coalesce(?, result), updated_at = ? where id = ?`).run(
      status,
      result ?? null,
      Date.now(),
      id,
    );
  }

  getJob(id: string): JobRow | undefined {
    const row = this.stmt(`select * from jobs where id = ?`).get(id) as RawJob | undefined;
    return row ? toJob(row) : undefined;
  }

  listJobs(status?: string): JobRow[] {
    const rows = status
      ? this.stmt(`select * from jobs where status = ? order by created_at`).all(status)
      : this.stmt(`select * from jobs order by created_at desc limit 200`).all();
    return (rows as unknown as RawJob[]).map(toJob);
  }

  // --------------------------------------------------------------------- kv

  getKv<T>(key: string, fallback: T): T {
    const row = this.stmt(`select value from kv where key = ?`).get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  setKv(key: string, value: unknown): void {
    this.stmt(`insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`).run(
      key,
      JSON.stringify(value),
    );
  }
}

interface ObjectRow {
  id: string;
  kind: string;
  summary: string;
  body: string;
  links: string;
  status: string | null;
  created_at: number;
  updated_at: number;
}

interface RawSession {
  id: string;
  role: string;
  status: string;
  epoch: number;
  task: string | null;
  model: string | null;
  meta: string;
  created_at: number;
  updated_at: number;
  last_progress_at: number;
  error_count: number;
}

interface RawJob {
  id: string;
  owner: string;
  kind: string;
  status: string;
  params: string;
  result: string | null;
  created_at: number;
  updated_at: number;
}

function toObject<T>(row: ObjectRow): StoredObject<T> {
  return {
    id: row.id,
    kind: row.kind,
    summary: row.summary,
    body: JSON.parse(row.body) as T,
    links: JSON.parse(row.links) as string[],
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toSession(row: RawSession): SessionRow {
  return {
    id: row.id,
    role: row.role,
    status: row.status,
    epoch: Number(row.epoch),
    task: row.task,
    model: row.model,
    meta: JSON.parse(row.meta) as Record<string, unknown>,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastProgressAt: Number(row.last_progress_at),
    errorCount: Number(row.error_count),
  };
}

function toJob(row: RawJob): JobRow {
  return {
    id: row.id,
    owner: row.owner,
    kind: row.kind,
    status: row.status,
    params: JSON.parse(row.params) as Record<string, unknown>,
    result: row.result,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
