import { makeTrigger } from "../events/trigger.js";
import type { Runtime } from "../runtime.js";
import { logger } from "../util/log.js";

const log = logger("digest");

/** Emits one `daily_digest` trigger per UTC day at DAILY_DIGEST_TIME, catching up after a restart. */
export class DailyDigest {
  private timer?: NodeJS.Timeout;

  constructor(private readonly rt: Runtime) {}

  start(): void {
    this.check();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private check(now = Date.now()): void {
    const [hh, mm] = this.rt.config.dailyDigestTime.split(":").map(Number);
    const today = new Date(now).toISOString().slice(0, 10);
    const dueToday = Date.parse(`${today}T00:00:00Z`) + (hh * 60 + mm) * 60_000;
    const last = this.rt.store.getKv<string>("last_digest_date", "");
    if (now >= dueToday && last !== today) this.fire(today);
    const next = now >= dueToday ? dueToday + 86_400_000 : dueToday;
    this.timer = setTimeout(() => this.check(), Math.max(1_000, next - Date.now() + 500));
    this.timer.unref?.();
  }

  fire(date: string): void {
    this.rt.store.setKv("last_digest_date", date);
    log.info(`daily digest due for ${date}`);
    this.rt.ingest(
      makeTrigger({
        source: "schedule",
        kind: "daily_digest",
        threadKey: `digest:${date}`,
        summary: `Daily digest due for ${date} (UTC): signals, scorecard, paper results, notable events`,
        payload: { date, mode: this.rt.config.mode },
        explicit: true,
        dedupeKey: `digest:${date}`,
      }),
    );
  }
}
