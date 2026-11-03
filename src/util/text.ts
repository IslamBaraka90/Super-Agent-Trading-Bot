export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Cut to `max` characters on a word boundary when one is close. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.7 ? cut.slice(0, space) : cut).trimEnd();
}

/**
 * Spill: keep the first `cap` characters inline and leave a pointer the model
 * can follow with `recall(id, offset)` to read the rest.
 */
export function spill(text: string, cap: number, id: string, offset = 0): string {
  const body = text.slice(offset);
  if (body.length <= cap) return body;
  const head = truncate(body, cap);
  let next = offset + head.length;
  while (next < text.length && /\s/.test(text[next])) next++;
  const rest = text.length - next;
  return `${head} ... (+${rest.toLocaleString("en-US")} chars, recall("${id}", offset=${next}))`;
}

export function oneLine(text: string, max = 160): string {
  return truncate(text.replace(/\s+/g, " ").trim(), max);
}

/** Round a price to a sensible number of significant decimals for display. */
export function fmtPrice(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return Number(value.toFixed(decimals)).toString();
}

export function fmtPct(value: number, decimals = 2): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}%`;
}

export function isoMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16) + "Z";
}
