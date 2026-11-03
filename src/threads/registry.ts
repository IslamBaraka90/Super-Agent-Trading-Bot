import type { Store } from "../state/store.js";

/**
 * Threads and subscriptions (design §3.2). A thread is an event stream - one
 * symbol/timeframe, one position, one chat - and sessions subscribe to the
 * threads they own. Subscriptions are many-to-many.
 */
export class ThreadRegistry {
  constructor(private readonly store: Store) {}

  /** Make sure the thread exists as a recallable object. Its id is the key itself. */
  ensure(key: string): void {
    if (!this.store.getObject(key)) {
      this.store.putObject({ id: key, kind: "thread", summary: describeThread(key), body: { key }, status: "active" });
    }
  }

  subscribe(key: string, sessionId: string): void {
    this.ensure(key);
    this.store.subscribe(key, sessionId);
    this.store.updateObject(key, { links: [sessionId] });
  }

  unsubscribe(key: string, sessionId: string): void {
    this.store.unsubscribe(key, sessionId);
  }

  unsubscribeAll(sessionId: string): void {
    this.store.unsubscribeAll(sessionId);
  }

  subscribers(key: string): string[] {
    return this.store.subscribers(key);
  }

  threadsOf(sessionId: string): string[] {
    return this.store.threadsOf(sessionId);
  }
}

export function describeThread(key: string): string {
  const [type, a, b] = key.split(":");
  switch (type) {
    case "mkt":
      return `${a} ${b} candle closes`;
    case "pos":
      return `paper position ${a}`;
    case "chat":
      return `chat on ${a}${b ? ` (${b})` : ""}`;
    case "job":
      return `background job ${a}`;
    case "sys":
      return a === "endpoint" ? "execution endpoint status" : `system: ${a}`;
    case "digest":
      return `daily digest ${a}`;
    case "wrk":
      return `reports from worker ${a}`;
    case "sig":
      return `signal ${a}`;
    default:
      return key;
  }
}
