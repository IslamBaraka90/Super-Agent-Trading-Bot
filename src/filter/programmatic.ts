import type { Config } from "../config.js";
import type { Trigger } from "../events/trigger.js";

export type Route = "drop" | "passthrough" | "subscribers" | "router" | "semantic" | "watchdog";

export interface FastPathDecision {
  route: Route;
  reason: string;
}

const DEDUPE_TTL_MS = 2 * 86_400_000;

/**
 * The fast path (design §3.1): deterministic admission and routing in code,
 * before any model is called.
 */
export class ProgrammaticFilter {
  private seen = new Map<string, number>();

  constructor(
    private readonly config: Config,
    private readonly subscribersOf: (thread: string) => string[],
  ) {}

  decide(t: Trigger): FastPathDecision {
    if (t.dedupeKey) {
      const now = Date.now();
      if (this.seen.has(t.dedupeKey)) return { route: "drop", reason: "duplicate" };
      this.seen.set(t.dedupeKey, now);
      if (this.seen.size > 50_000) this.prune(now);
    }
    const hasSubscribers = this.subscribersOf(t.threadKey).length > 0;

    switch (t.source) {
      case "chat":
        return this.chat(t);

      case "market": {
        if (hasSubscribers) return { route: "passthrough", reason: "thread owned by a worker" };
        const setups = (t.payload.setups as { score: number; stop: number; entry: number }[] | undefined) ?? [];
        if (setups.length === 0) return { route: "drop", reason: "no setup" };
        const best = Math.max(...setups.map((s) => s.score));
        if (best < this.config.minSetupScore) {
          return { route: "drop", reason: `best score ${best} below MIN_SETUP_SCORE ${this.config.minSetupScore}` };
        }
        return { route: "semantic", reason: `setup score ${best}` };
      }

      case "broker":
        return hasSubscribers
          ? { route: "passthrough", reason: "position owned by a worker" }
          : { route: "router", reason: "position event with no owning worker" };

      case "job":
        return hasSubscribers
          ? { route: "subscribers", reason: "job result for its owner" }
          : { route: "drop", reason: "job owner is gone" };

      case "system":
        return hasSubscribers
          ? { route: "passthrough", reason: "system event with subscribers" }
          : { route: "router", reason: "system event" };

      case "worker":
      case "schedule":
        return { route: "router", reason: `${t.source} event` };
    }
  }

  private chat(t: Trigger): FastPathDecision {
    const p = t.payload as { text?: string; allowed?: boolean; isGroup?: boolean };
    if (p.allowed === false) return { route: "drop", reason: "author or chat not on the allowlist" };
    const text = (p.text ?? "").trim();
    if (!text) return { route: "drop", reason: "empty message" };
    if (/^\/watchdog\b/i.test(text)) return { route: "watchdog", reason: "owner command for the watchdog" };
    if (t.explicit) return { route: "router", reason: "explicit request" };
    if (p.isGroup) {
      const mode = t.replyTo?.channel === "telegram" ? this.config.telegram.groupMode : "explicit";
      if (mode === "ignore") return { route: "drop", reason: "group messages ignored" };
      if (mode === "candidate") return { route: "semantic", reason: "group message candidate" };
      return { route: "drop", reason: "group message not addressed to the bot" };
    }
    return { route: "router", reason: "direct message" };
  }

  private prune(now: number): void {
    for (const [key, at] of this.seen) if (now - at > DEDUPE_TTL_MS) this.seen.delete(key);
  }
}
