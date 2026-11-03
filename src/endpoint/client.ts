import type { ExecutionEndpoint } from "./endpoint.js";
import { logger } from "../util/log.js";

const log = logger("endpoint-client");

export class EndpointOfflineError extends Error {
  constructor(message = "execution endpoint is offline") {
    super(message);
    this.name = "EndpointOfflineError";
  }
}

export interface EndpointClient {
  readonly online: boolean;
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Called with true/false whenever the endpoint's reachability changes. */
  onStatus(listener: (online: boolean) => void): void;
  close(): void;
}

/** Same-process endpoint: the default for a single machine. */
export class LocalEndpointClient implements EndpointClient {
  readonly online = true;
  constructor(readonly endpoint: ExecutionEndpoint) {}
  call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.endpoint.handle(method, params) as Promise<T>;
  }
  onStatus(): void {}
  close(): void {}
}

/** Remote endpoint daemon over HTTP JSON-RPC (BYOM: the broker stays on its own machine). */
export class HttpEndpointClient implements EndpointClient {
  private isOnline = true;
  private listeners: ((online: boolean) => void)[] = [];
  private timer: NodeJS.Timeout;

  constructor(
    private readonly url: string,
    private readonly token?: string,
  ) {
    this.timer = setInterval(() => void this.ping(), 15_000);
  }

  get online(): boolean {
    return this.isOnline;
  }

  onStatus(listener: (online: boolean) => void): void {
    this.listeners.push(listener);
  }

  close(): void {
    clearInterval(this.timer);
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.url.replace(/\/$/, "")}/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ method, params }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      this.setOnline(false);
      throw new EndpointOfflineError(`execution endpoint unreachable: ${(err as Error).message}`);
    }
    this.setOnline(true);
    const body = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as {
      ok: boolean;
      result?: T;
      error?: string;
    };
    if (!body.ok) throw new Error(body.error ?? `endpoint error (HTTP ${res.status})`);
    return body.result as T;
  }

  private async ping(): Promise<void> {
    try {
      await this.call("health");
    } catch {
      /* status already updated */
    }
  }

  private setOnline(online: boolean): void {
    if (online === this.isOnline) return;
    this.isOnline = online;
    log.warn(`execution endpoint ${online ? "back online" : "offline"}`);
    for (const l of this.listeners) l(online);
  }
}
