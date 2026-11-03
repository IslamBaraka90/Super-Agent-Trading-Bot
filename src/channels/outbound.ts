import type { Channel } from "./hub.js";

/** Discord incoming webhook (send only). */
export class DiscordChannel implements Channel {
  readonly name = "discord";
  readonly style = "im" as const;
  readonly inbound = false;

  constructor(private readonly url: string) {}

  start(): void {}
  stop(): void {}

  async send(text: string): Promise<void> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, 1900) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Discord webhook returned ${res.status}`);
  }
}

/** Generic JSON webhook (send only). Async style: full, structured detail is allowed. */
export class WebhookChannel implements Channel {
  readonly name = "webhook";
  readonly style = "async" as const;
  readonly inbound = false;

  constructor(private readonly url: string) {}

  start(): void {}
  stop(): void {}

  async send(text: string, target?: string): Promise<void> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, target: target ?? null, at: new Date().toISOString(), source: "super-agent-trading-bot" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`webhook returned ${res.status}`);
  }
}

/** HTTP API conversation: replies are kept in an outbox read with GET /outbox. */
export class HttpChannel implements Channel {
  readonly name = "http";
  readonly style = "im" as const;
  readonly inbound = true;
  readonly outbox: { at: string; target: string | null; text: string }[] = [];

  start(): void {}
  stop(): void {}

  async send(text: string, target?: string): Promise<void> {
    this.outbox.push({ at: new Date().toISOString(), target: target ?? null, text });
    if (this.outbox.length > 200) this.outbox.splice(0, this.outbox.length - 200);
  }
}
