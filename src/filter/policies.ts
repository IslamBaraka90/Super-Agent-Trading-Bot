import type { Store } from "../state/store.js";
import { newId } from "../util/ids.js";
import { oneLine } from "../util/text.js";

export interface Policy {
  id: string;
  text: string;
  createdBy: string;
  expiresAt: number | null;
}

const DEFAULT_POLICIES = [
  "Prefer setups that agree with the trend (trend=up for longs, trend=down for shorts). Skip counter-trend setups unless their score is at least 0.75.",
  "On 1m and 3m timeframes, only act on breakouts with volume z above 2.5. Ignore other setups on those timeframes.",
  "Skip a setup when the same symbol and timeframe already had an escalated setup within the last 3 candles (see recent escalations).",
  "Skip setups whose stop is closer than 0.15% of price: that is noise, not a trade.",
  "In group chats, act only on messages that ask about markets, positions, signals or the bot itself. Ignore small talk.",
];

/**
 * Semantic filter policies, written in plain language and editable at runtime
 * (the owner tells the Router "ignore SOL 1m until tomorrow").
 */
export class PolicyBook {
  constructor(private readonly store: Store) {}

  seedDefaults(): void {
    if (this.store.listObjects("policy", { limit: 1 }).length > 0) return;
    for (const text of DEFAULT_POLICIES) this.add(text, "default");
  }

  active(now = Date.now()): Policy[] {
    return this.store
      .listObjects<{ text: string; createdBy: string; expiresAt: number | null }>("policy", { status: "active" })
      .filter((o) => o.body.expiresAt === null || o.body.expiresAt > now)
      .map((o) => ({ id: o.id, text: o.body.text, createdBy: o.body.createdBy, expiresAt: o.body.expiresAt }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  add(text: string, createdBy: string, expiresInHours?: number): Policy {
    const id = newId("pol");
    const expiresAt = expiresInHours ? Date.now() + expiresInHours * 3_600_000 : null;
    this.store.putObject({
      id,
      kind: "policy",
      summary: oneLine(text, 140),
      body: { text, createdBy, expiresAt },
      status: "active",
    });
    return { id, text, createdBy, expiresAt };
  }

  remove(id: string): boolean {
    const obj = this.store.getObject(id);
    if (!obj || obj.kind !== "policy") return false;
    this.store.updateObject(id, { status: "removed" });
    return true;
  }

  render(): string {
    const policies = this.active();
    if (policies.length === 0) return "(no active policies)";
    return policies
      .map((p) => `- [${p.id}] ${p.text}${p.expiresAt ? ` (until ${new Date(p.expiresAt).toISOString().slice(0, 16)}Z)` : ""}`)
      .join("\n");
  }
}
