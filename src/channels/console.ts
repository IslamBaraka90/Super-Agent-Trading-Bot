import { createInterface, type Interface } from "node:readline";
import type { Channel, InboundMessage } from "./hub.js";

/** Chat with the agent from the terminal. Everything typed here is an explicit owner request. */
export class ConsoleChannel implements Channel {
  readonly name = "console";
  readonly style = "im" as const;
  readonly inbound = true;
  private rl?: Interface;

  start(onInbound: (m: InboundMessage) => void): void {
    if (!process.stdin.isTTY) return;
    this.rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    this.rl.setPrompt("you> ");
    this.rl.prompt();
    this.rl.on("line", (line) => {
      const text = line.trim();
      if (text) {
        onInbound({
          channel: this.name,
          conversation: "owner",
          author: "owner",
          text,
          explicit: true,
          isGroup: false,
          allowed: true,
        });
      }
      this.rl?.prompt();
    });
  }

  async send(text: string): Promise<void> {
    process.stdout.write(`\nbot> ${text}\n`);
    this.rl?.prompt(true);
  }

  stop(): void {
    this.rl?.close();
  }
}
