import { newId } from "../util/ids.js";

/** Everything the agent reacts to (design §3). */
export type TriggerSource = "market" | "chat" | "broker" | "schedule" | "worker" | "job" | "system";

export interface Trigger {
  id: string;
  source: TriggerSource;
  kind: string;
  threadKey: string;
  at: number;
  summary: string;
  payload: Record<string, unknown>;
  /** Addressed to the bot directly (a DM, a command, an owner request). */
  explicit?: boolean;
  replyTo?: { channel: string; target?: string };
  /** Same key twice = duplicate, dropped by the fast path. */
  dedupeKey?: string;
  /** Extra object ids worth inlining next to this trigger. */
  links?: string[];
}

export function makeTrigger(t: Omit<Trigger, "id" | "at"> & { at?: number }): Trigger {
  return { ...t, id: newId("trg"), at: t.at ?? Date.now() };
}
