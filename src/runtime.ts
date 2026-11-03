import { join } from "node:path";
import type { Config, LlmRole } from "./config.js";
import { Store } from "./state/store.js";
import { ThreadRegistry } from "./threads/registry.js";
import type { LlmClient } from "./llm/types.js";
import { createLlmClient } from "./llm/factory.js";
import { ExecutionEndpoint } from "./endpoint/endpoint.js";
import { HttpEndpointClient, LocalEndpointClient, type EndpointClient } from "./endpoint/client.js";
import { ChannelHub, type Channel, type InboundMessage } from "./channels/hub.js";
import { ConsoleChannel } from "./channels/console.js";
import { TelegramChannel } from "./channels/telegram.js";
import { DiscordChannel, HttpChannel, WebhookChannel } from "./channels/outbound.js";
import { PolicyBook } from "./filter/policies.js";
import { ProgrammaticFilter } from "./filter/programmatic.js";
import { SemanticFilter } from "./filter/semantic.js";
import { JobManager } from "./agent/jobs.js";
import type { SessionEvent } from "./agent/session.js";
import { Router, ROUTER_ID } from "./router/router.js";
import { WorkerPool } from "./workers/pool.js";
import { Speculator } from "./speculative/speculator.js";
import { SignalBook } from "./signals/book.js";
import { MarketFeed } from "./market/feed.js";
import { Watchdog, WATCHDOG_ID } from "./watchdog/watchdog.js";
import { DailyDigest } from "./digest/daily.js";
import { makeTrigger, type Trigger } from "./events/trigger.js";
import { renderTrigger } from "./context/render.js";
import type { BrokerEvent } from "./trading/paper-broker.js";
import { oneLine } from "./util/text.js";
import { logger } from "./util/log.js";

const log = logger("runtime");

export interface RuntimeOptions {
  /** Override LLM construction (tests). */
  llmFactory?: (role: LlmRole) => LlmClient;
  endpoint?: EndpointClient;
  store?: Store;
  /** Replace the configured channels (tests). */
  channels?: Channel[];
  feed?: boolean;
  watchdogTimer?: boolean;
  brokerPollMs?: number;
}

/**
 * Wires the system together and owns the trigger pipeline (design §3):
 * fast path -> pass-through to subscribers | semantic filter | Router | Watchdog.
 */
export class Runtime {
  readonly store: Store;
  readonly threads: ThreadRegistry;
  readonly endpoint: EndpointClient;
  readonly hub: ChannelHub;
  readonly policies: PolicyBook;
  readonly jobs: JobManager;
  readonly fast: ProgrammaticFilter;
  readonly semantic: SemanticFilter;
  readonly router: Router;
  readonly pool: WorkerPool;
  readonly speculator: Speculator;
  readonly signals: SignalBook;
  readonly feed: MarketFeed;
  readonly watchdog: Watchdog;
  readonly digest: DailyDigest;
  readonly metrics = { llmErrors: [] as number[], refusals: [] as number[], triggers: 0, startedAt: Date.now() };
  feedStarted = false;

  private llms = new Map<LlmRole, LlmClient>();
  private localEndpoint?: ExecutionEndpoint;
  private brokerTimer?: NodeJS.Timeout;
  private polling = false;

  constructor(
    readonly config: Config,
    private readonly opts: RuntimeOptions = {},
  ) {
    this.store = opts.store ?? new Store(join(config.dataDir, "agent.db"));
    this.threads = new ThreadRegistry(this.store);
    if (opts.endpoint) {
      this.endpoint = opts.endpoint;
    } else if (config.endpoint === "local") {
      this.localEndpoint = new ExecutionEndpoint({
        marketDataUrl: config.marketDataUrl,
        ledgerPath: join(config.dataDir, "paper.db"),
        symbols: config.symbols,
        paper: config.paper,
        risk: config.risk,
      });
      this.endpoint = new LocalEndpointClient(this.localEndpoint);
    } else {
      this.endpoint = new HttpEndpointClient(config.endpoint, config.endpointToken);
    }
    this.hub = new ChannelHub(this.store, config.imWordLimit);
    this.policies = new PolicyBook(this.store);
    this.jobs = new JobManager(this.store, (t) => this.ingest(t), (thread, sid) => this.threads.subscribe(thread, sid));
    this.fast = new ProgrammaticFilter(config, (thread) => this.threads.subscribers(thread));
    this.semantic = new SemanticFilter({
      llm: this.llm("filter"),
      store: this.store,
      policies: this.policies,
      minScore: config.minSetupScore,
      onDecision: (t, outcome) => this.onFilterDecision(t, outcome.act, `${outcome.by}: ${outcome.reason}`),
    });
    this.router = new Router(this);
    this.pool = new WorkerPool(this);
    this.speculator = new Speculator(this);
    this.signals = new SignalBook(this.store, (t) => this.ingest(t));
    this.feed = new MarketFeed(this);
    this.watchdog = new Watchdog(this);
    this.digest = new DailyDigest(this);
  }

  llm(role: LlmRole): LlmClient {
    let client = this.llms.get(role);
    if (!client) {
      client = this.opts.llmFactory ? this.opts.llmFactory(role) : createLlmClient(role, this.config);
      this.llms.set(role, client);
    }
    return client;
  }

  async start(): Promise<void> {
    this.policies.seedDefaults();
    for (const ch of this.opts.channels ?? this.configuredChannels()) this.hub.register(ch);
    this.hub.startAll((m) => this.ingestChat(m));

    this.router.start();
    this.watchdog.start(this.opts.watchdogTimer ?? true);
    this.jobs.recoverInterrupted();
    const resumed = this.pool.resumeAll();
    for (const row of this.store.triggersWithStatus("semantic")) {
      const obj = this.store.getObject(row.id);
      if (obj) this.semantic.enqueue(obj.body as unknown as Trigger);
    }

    this.endpoint.onStatus((online) =>
      this.ingest(
        makeTrigger({
          source: "system",
          kind: online ? "endpoint_online" : "endpoint_offline",
          threadKey: "sys:endpoint",
          summary: online ? "Execution endpoint is back online" : "Execution endpoint is offline: no market data or paper orders",
          payload: { online },
        }),
      ),
    );
    this.localEndpoint?.start();
    await this.initBrokerCursor();
    this.brokerTimer = setInterval(() => void this.pollBroker(), this.opts.brokerPollMs ?? 5_000);
    this.brokerTimer.unref?.();

    if (this.opts.feed ?? true) {
      this.feedStarted = true;
      await this.feed.start();
    }
    this.digest.start();

    const roles = (["router", "worker", "filter", "watchdog"] as LlmRole[])
      .map((r) => `${r}=${this.llm(r).provider}:${this.llm(r).model}`)
      .join(" ");
    log.info(`started in ${this.config.mode} mode | ${roles} | channels: ${this.hub.names().join(", ")} | resumed ${resumed} workers`);
  }

  async stop(): Promise<void> {
    if (this.brokerTimer) clearInterval(this.brokerTimer);
    this.feed.stop();
    this.watchdog.stop();
    this.digest.stop();
    this.hub.stopAll();
    this.endpoint.close();
    this.localEndpoint?.stop();
  }

  // --------------------------------------------------------------- pipeline

  ingest(t: Trigger): void {
    this.metrics.triggers++;
    const decision = this.fast.decide(t);
    if (decision.route !== "drop") {
      this.threads.ensure(t.threadKey);
      this.store.putObject({
        id: t.id,
        kind: "trigger",
        summary: t.summary,
        body: t,
        links: [t.threadKey, ...(t.links ?? [])],
        status: decision.route,
      });
    }
    this.store.recordTrigger(t.id, t.threadKey, decision.route === "drop" ? "dropped" : decision.route, decision.route, decision.reason);
    log.debug(`${t.id} ${t.source}/${t.kind} -> ${decision.route} (${decision.reason})`);

    switch (decision.route) {
      case "drop":
        return;
      case "subscribers":
        this.deliverToSubscribers(t);
        return;
      case "passthrough":
        this.deliverToSubscribers(t);
        this.router.fyi(t);
        return;
      case "router":
        this.router.submit(t);
        return;
      case "semantic":
        this.semantic.enqueue(t);
        return;
      case "watchdog":
        this.watchdog.push(renderTrigger(t, this.store));
        return;
    }
  }

  private deliverToSubscribers(t: Trigger): void {
    let delivered = 0;
    for (const sid of this.threads.subscribers(t.threadKey)) {
      if (sid === ROUTER_ID) {
        this.router.submit(t);
        delivered++;
      } else if (sid === WATCHDOG_ID) {
        this.watchdog.push(renderTrigger(t, this.store));
        delivered++;
      } else if (this.pool.deliver(sid, t)) {
        delivered++;
      } else {
        this.threads.unsubscribe(t.threadKey, sid); // stale subscription of a finished session
      }
    }
    if (delivered === 0 && t.source === "broker") this.router.submit(t);
  }

  private onFilterDecision(t: Trigger, act: boolean, reason: string): void {
    this.store.setTriggerStatus(t.id, act ? "escalated" : "filtered", reason);
    this.store.updateObject<Record<string, unknown>>(t.id, { status: act ? "escalated" : "filtered", body: { filterReason: reason } });
    if (act) this.router.submit(t);
  }

  /** A chat message from any channel becomes a trigger on its conversation thread. */
  ingestChat(m: InboundMessage): void {
    this.ingest(
      makeTrigger({
        source: "chat",
        kind: "message",
        threadKey: `chat:${m.channel}:${m.conversation}`,
        summary: `${m.author} on ${m.channel}: ${oneLine(m.text, 140)}`,
        payload: { text: m.text, author: m.author, isGroup: m.isGroup, allowed: m.allowed },
        explicit: m.explicit,
        replyTo: { channel: m.channel, ...(m.conversation === "owner" ? {} : { target: m.conversation }) },
      }),
    );
  }

  onSessionEvent(e: SessionEvent): void {
    const now = Date.now();
    if (e.type === "llm_error") this.metrics.llmErrors.push(now);
    if (e.type === "refusal") this.metrics.refusals.push(now);
    const cutoff = now - 6 * 3_600_000;
    this.metrics.llmErrors = this.metrics.llmErrors.filter((t) => t > cutoff);
    this.metrics.refusals = this.metrics.refusals.filter((t) => t > cutoff);
  }

  // ----------------------------------------------------------- broker events

  private async initBrokerCursor(): Promise<void> {
    if (this.store.getKv<number | null>("broker_seq", null) !== null) return;
    try {
      const events = await this.endpoint.call<BrokerEvent[]>("broker.events", { since: 0, limit: 1_000_000 });
      this.store.setKv("broker_seq", events.length ? events[events.length - 1].seq : 0);
    } catch {
      /* endpoint offline at boot; the first successful poll starts from 0 */
    }
  }

  /** Broker events (fills, stop-outs, targets) become triggers on their pos:<id> thread. */
  async pollBroker(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      let cursor = this.store.getKv<number>("broker_seq", 0);
      const events = await this.endpoint.call<BrokerEvent[]>("broker.events", { since: cursor });
      for (const e of events) {
        cursor = e.seq;
        if (e.kind === "opened") continue; // the worker that placed the order already has the fill
        if (e.kind === "closed" || e.kind === "stop_hit" || e.kind === "target_hit") {
          this.store.updateObject<Record<string, unknown>>(e.positionId, { status: "closed", body: { exit: e.data } });
        }
        this.ingest(
          makeTrigger({
            source: "broker",
            kind: e.kind,
            threadKey: `pos:${e.positionId}`,
            summary: e.summary,
            payload: { positionId: e.positionId, symbol: e.symbol, ...e.data },
            links: [e.positionId],
            dedupeKey: `broker:${e.seq}`,
            at: e.at,
          }),
        );
      }
      this.store.setKv("broker_seq", cursor);
    } catch (err) {
      log.debug("broker poll failed", err);
    } finally {
      this.polling = false;
    }
  }

  // ---------------------------------------------------------------- status

  async overview(): Promise<Record<string, unknown>> {
    let account: unknown = null;
    try {
      account = await this.endpoint.call("broker.account");
    } catch (err) {
      account = { error: (err as Error).message };
    }
    return {
      mode: this.config.mode,
      uptimeMin: Math.round((Date.now() - this.metrics.startedAt) / 60_000),
      llm: Object.fromEntries((["router", "worker", "filter", "watchdog"] as LlmRole[]).map((r) => [r, `${this.llm(r).provider}:${this.llm(r).model}`])),
      router: { status: this.router.session.status, queued: this.router.session.pending },
      workers: this.pool.list(60),
      openSignals: this.signals.open().map((s) => ({ id: s.id, summary: s.summary })),
      scorecard7d: this.signals.scorecard(Date.now() - 7 * 86_400_000),
      account,
      endpointOnline: this.endpoint.online,
      feedLastSuccess: this.feed.lastSuccessAt ? new Date(this.feed.lastSuccessAt).toISOString() : null,
      triggers24h: this.store.triggerCounts(Date.now() - 86_400_000),
    };
  }

  private configuredChannels(): Channel[] {
    const c = this.config;
    const channels: Channel[] = [];
    if (c.console) channels.push(new ConsoleChannel());
    if (c.telegram.token) channels.push(new TelegramChannel(c.telegram.token, c.telegram.chatIds));
    if (c.discordWebhookUrl) channels.push(new DiscordChannel(c.discordWebhookUrl));
    if (c.webhookUrl) channels.push(new WebhookChannel(c.webhookUrl));
    if (c.httpPort > 0) channels.push(new HttpChannel());
    return channels;
  }
}
