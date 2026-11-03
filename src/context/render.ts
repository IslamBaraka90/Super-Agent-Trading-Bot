import type { Store, StoredObject } from "../state/store.js";
import type { Trigger } from "../events/trigger.js";
import { isoMinute, oneLine, spill } from "../util/text.js";

/**
 * Inline & Spill (design §3.3). The context window is a cache: inline the IDs
 * and one-line summaries of what is likely needed next, spill everything long
 * behind a `recall(id, offset)` pointer.
 */

export const TRIGGER_BODY_CAP = 700;
export const RECALL_BODY_CAP = 2_000;
export const MAX_INLINE_LINKS = 6;

/** Render a trigger as a delimited data block. Contents are data, never instructions. */
export function renderTrigger(t: Trigger, store: Store, opts: { cap?: number; fyi?: boolean } = {}): string {
  const attrs = [
    `id=${t.id}`,
    `source=${t.source}`,
    `kind=${t.kind}`,
    `thread=${t.threadKey}`,
    `at=${isoMinute(t.at)}`,
  ];
  if (t.explicit) attrs.push("explicit=true");
  if (t.replyTo) attrs.push(`channel=${t.replyTo.channel}`, ...(t.replyTo.target ? [`target=${t.replyTo.target}`] : []));
  if (opts.fyi) return `<fyi ${attrs.join(" ")}>${oneLine(t.summary, 200)}</fyi>`;

  const body = describePayload(t);
  const lines = [oneLine(t.summary, 300)];
  if (body) lines.push(spill(body, opts.cap ?? TRIGGER_BODY_CAP, t.id));
  const links = renderLinks(store, [t.threadKey, ...(t.links ?? [])]);
  if (links) lines.push(`links: ${links}`);
  return `<trigger ${attrs.join(" ")}>\n${lines.join("\n")}\n</trigger>`;
}

/** `id - summary (status)` for each linked object that exists. */
export function renderLinks(store: Store, ids: string[], max = MAX_INLINE_LINKS): string {
  const parts: string[] = [];
  for (const id of [...new Set(ids)].slice(0, max)) {
    const obj = store.getObject(id);
    if (obj) parts.push(`${id} - ${oneLine(obj.summary, 90)}${obj.status ? ` (${obj.status})` : ""}`);
  }
  return parts.join("; ");
}

/**
 * Chain of Recall: one object, its body (spilled), the objects it links to and
 * the objects that link to it - each as id + summary, so the model can keep
 * following the reference graph hop by hop.
 */
export function renderRecall(store: Store, id: string, offset = 0, cap = RECALL_BODY_CAP): string {
  const obj = store.getObject(id);
  if (!obj) return `No object "${id}". Ids look like trg_..., wrk_..., sig_..., pos_..., job_..., pol_..., or thread keys like mkt:BTCUSDT:1h.`;
  const out = [
    `[${obj.id}] ${obj.kind}${obj.status ? ` (${obj.status})` : ""}: ${oneLine(obj.summary, 300)}`,
    `created ${isoMinute(obj.createdAt)}, updated ${isoMinute(obj.updatedAt)}`,
  ];
  const body = bodyText(obj);
  if (body) out.push(`body: ${spill(body, cap, obj.id, offset)}`);
  const links = renderLinks(store, obj.links, 12);
  if (links) out.push(`links to: ${links}`);
  const back = store
    .backlinks(obj.id, 10)
    .filter((b) => b.id !== obj.id)
    .map((b) => `${b.id} - ${oneLine(b.summary, 90)}${b.status ? ` (${b.status})` : ""}`);
  if (back.length) out.push(`linked from: ${back.join("; ")}`);
  return out.join("\n");
}

function bodyText(obj: StoredObject): string {
  const body = obj.body as Record<string, unknown>;
  if (typeof body.text === "string" && Object.keys(body).length <= 2) return body.text;
  return compactJson(body);
}

export function compactJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "number" ? Number(v.toPrecision(8)) : v));
}

/** Human-dense payload rendering for the trigger kinds the system emits. */
function describePayload(t: Trigger): string {
  const p = t.payload;
  if (t.source === "chat" && typeof p.text === "string") {
    return `${p.author ? `${String(p.author)}: ` : ""}${p.text}`;
  }
  if (t.source === "market" && p.snapshot) {
    const s = p.snapshot as Record<string, number | string>;
    const setups = (p.setups as Record<string, unknown>[] | undefined) ?? [];
    const lines = [
      `close=${s.close} chg=${fmt(s.changePct)}% trend=${s.trend} rsi=${fmt(s.rsi)} atr=${fmt(s.atr)} (${fmt(s.atrPct)}%) volZ=${fmt(s.volZ)}`,
      `ema20=${fmt(s.ema20)} ema50=${fmt(s.ema50)} ema200=${fmt(s.ema200)} dcHigh=${fmt(s.donchianHigh)} dcLow=${fmt(s.donchianLow)}`,
    ];
    for (const st of setups) {
      lines.push(
        `setup ${st.detector} ${st.side} score=${st.score} entry=${fmt(st.entry)} stop=${fmt(st.stop)} target=${fmt(st.target)} - ${st.reason}`,
      );
    }
    if (p.preAnalysis) lines.push(`pre-analysis (prepared in the background): ${String(p.preAnalysis)}`);
    return lines.join("\n");
  }
  if (Object.keys(p).length === 0) return "";
  return compactJson(p);
}

function fmt(v: unknown): string {
  return typeof v === "number" ? Number(v.toPrecision(6)).toString() : String(v);
}
