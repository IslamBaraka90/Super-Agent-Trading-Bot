import type { Store } from "../state/store.js";
import { newId } from "../util/ids.js";
import { oneLine, wordCount } from "../util/text.js";
import { logger } from "../util/log.js";

const log = logger("channels");

export interface InboundMessage {
  channel: string;
  conversation: string;
  author: string;
  text: string;
  /** Addressed to the bot: a DM, a command, a mention, a reply to the bot. */
  explicit: boolean;
  isGroup: boolean;
  /** False when the author or chat is not on the allowlist. */
  allowed: boolean;
}

export interface Channel {
  readonly name: string;
  /** im: short, conclusion first, word-capped. async: structured, full detail. */
  readonly style: "im" | "async";
  readonly inbound: boolean;
  start(onInbound: (m: InboundMessage) => void): void;
  send(text: string, target?: string): Promise<void>;
  stop(): void;
}

export class StyleError extends Error {}

/**
 * All outbound messages go through here (design §4.2), so channel norms are
 * enforced in code: an IM message over the word limit is rejected with an
 * error the model can act on.
 */
export class ChannelHub {
  private channels = new Map<string, Channel>();

  constructor(
    private readonly store: Store,
    private readonly imWordLimit: number,
  ) {}

  register(channel: Channel): void {
    this.channels.set(channel.name, channel);
  }

  names(): string[] {
    return [...this.channels.keys()];
  }

  get(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  startAll(onInbound: (m: InboundMessage) => void): void {
    for (const ch of this.channels.values()) {
      try {
        ch.start(onInbound);
      } catch (err) {
        log.error(`channel ${ch.name} failed to start`, err);
      }
    }
  }

  stopAll(): void {
    for (const ch of this.channels.values()) ch.stop();
  }

  checkStyle(channel: string, text: string): void {
    const ch = this.channels.get(channel);
    if (!ch) throw new StyleError(`Unknown channel "${channel}". Available: ${this.names().join(", ") || "none"}.`);
    if (!text.trim()) throw new StyleError("Message is empty.");
    if (ch.style === "im") {
      const words = wordCount(text);
      if (words > this.imWordLimit) {
        throw new StyleError(
          `Message is ${words} words; ${channel} allows at most ${this.imWordLimit}. ` +
            "Shorten it: conclusion first, then the one decision or question.",
        );
      }
    }
  }

  async send(channel: string, text: string, target?: string, from = "agent"): Promise<string> {
    this.checkStyle(channel, text);
    await this.channels.get(channel)!.send(text, target);
    const id = newId("msg");
    this.store.putObject({
      id,
      kind: "message",
      summary: `${from} -> ${channel}${target ? `:${target}` : ""}: ${oneLine(text, 120)}`,
      body: { channel, target: target ?? null, text, from },
      links: [`chat:${channel}${target ? `:${target}` : ""}`],
      status: "sent",
    });
    return id;
  }

  /** Send to several channels; returns the ones that failed with why. */
  async broadcast(text: string, channels: string[], from = "agent"): Promise<{ sent: string[]; failed: string[] }> {
    const sent: string[] = [];
    const failed: string[] = [];
    for (const name of channels) {
      if (!this.channels.has(name)) {
        failed.push(`${name}: not configured`);
        continue;
      }
      try {
        await this.send(name, text, undefined, from);
        sent.push(name);
      } catch (err) {
        failed.push(`${name}: ${(err as Error).message}`);
      }
    }
    return { sent, failed };
  }
}
