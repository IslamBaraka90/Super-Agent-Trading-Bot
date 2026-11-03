type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const level = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return ORDER[level] ?? ORDER.info;
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

/** Logs go to stderr so the console chat channel keeps stdout to itself. */
export function logger(component: string): Logger {
  const write = (level: Level, msg: string, data?: unknown) => {
    if (ORDER[level] < threshold()) return;
    const time = new Date().toISOString().slice(11, 19);
    const extra = data === undefined ? "" : " " + (data instanceof Error ? data.message : safeJson(data));
    process.stderr.write(`${time} ${level.padEnd(5)} [${component}] ${msg}${extra}\n`);
  };
  return {
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
  };
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 400 ? text.slice(0, 400) + "..." : text;
  } catch {
    return String(value);
  }
}
