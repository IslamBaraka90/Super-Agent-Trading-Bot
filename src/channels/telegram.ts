import type { Channel, InboundMessage } from "./hub.js";
import { logger } from "../util/log.js";

const log = logger("telegram");

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string; title?: string };
    from?: { id: number; username?: string; first_name?: string; is_bot?: boolean };
    reply_to_message?: { from?: { id: number; is_bot?: boolean } };
  };
}

/**
 * Telegram bot over long polling. Only chats listed in TELEGRAM_CHAT_IDS are
 * accepted; messages from anywhere else are dropped by the fast path, and the
 * chat id is logged so the owner can allow it.
 */
export class TelegramChannel implements Channel {
  readonly name = "telegram";
  readonly style = "im" as const;
  readonly inbound = true;
  private offset = 0;
  private stopped = false;
  private botId = 0;
  private botUsername = "";

  constructor(
    private readonly token: string,
    private readonly chatIds: string[],
  ) {}

  start(onInbound: (m: InboundMessage) => void): void {
    void this.run(onInbound);
  }

  stop(): void {
    this.stopped = true;
  }

  async send(text: string, target?: string): Promise<void> {
    const targets = target ? [target] : this.chatIds;
    if (targets.length === 0) throw new Error("no Telegram chat to send to (set TELEGRAM_CHAT_IDS)");
    for (const chatId of targets) {
      await this.api("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
    }
  }

  private async run(onInbound: (m: InboundMessage) => void): Promise<void> {
    try {
      const me = (await this.api("getMe", {})) as { id: number; username: string };
      this.botId = me.id;
      this.botUsername = me.username;
      log.info(`connected as @${me.username}`);
    } catch (err) {
      log.error("could not connect to Telegram", err);
      return;
    }
    while (!this.stopped) {
      try {
        const updates = (await this.api("getUpdates", { offset: this.offset, timeout: 30 }, 40_000)) as TgUpdate[];
        for (const u of updates) {
          this.offset = u.update_id + 1;
          const m = u.message;
          if (!m?.text || m.from?.is_bot) continue;
          const chatId = String(m.chat.id);
          const isGroup = m.chat.type !== "private";
          const allowed = this.chatIds.includes(chatId);
          if (!allowed) log.warn(`message from chat ${chatId} ignored; add it to TELEGRAM_CHAT_IDS to allow it`);
          const mentioned = this.botUsername && m.text.includes(`@${this.botUsername}`);
          const repliedToBot = m.reply_to_message?.from?.id === this.botId;
          onInbound({
            channel: this.name,
            conversation: chatId,
            author: m.from?.username ?? m.from?.first_name ?? "unknown",
            text: m.text,
            explicit: !isGroup || m.text.startsWith("/") || Boolean(mentioned) || repliedToBot,
            isGroup,
            allowed,
          });
        }
      } catch (err) {
        log.warn("poll failed, retrying in 5s", err);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  private async api(method: string, body: object, timeoutMs = 15_000): Promise<unknown> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
    return data.result;
  }
}
