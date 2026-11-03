import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const LLM_ROLES = ["router", "worker", "filter", "watchdog"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

export const TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export type BotMode = "signals" | "autonomous";
export type SourceMode = "explicit" | "candidate" | "ignore";

export interface RoleLlmConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Reasoning effort: Anthropic `output_config.effort`, OpenAI `reasoning_effort`. Empty = provider default. */
  effort?: string;
  maxTokens: number;
}

export interface Config {
  mode: BotMode;
  symbols: string[];
  timeframes: Timeframe[];
  marketDataUrl: string;

  llm: Record<LlmRole, RoleLlmConfig>;
  anthropicFallbacks: "auto" | "default" | "off";

  maxWorkers: number;
  maxToolStepsPerTurn: number;
  routerCompactTokens: number;
  workerCompactTokens: number;
  minSetupScore: number;
  targetR: number;
  speculative: boolean;
  nearSetupAtr: number;
  maxSpeculative: number;

  notifyChannels: string[];
  imWordLimit: number;
  console: boolean;
  telegram: { token?: string; chatIds: string[]; groupMode: SourceMode };
  discordWebhookUrl?: string;
  webhookUrl?: string;
  httpPort: number;
  httpToken?: string;

  dailyDigestTime: string;
  watchdogIntervalSec: number;
  workerStallMin: number;

  endpoint: string;
  endpointToken?: string;
  endpointPort: number;

  paper: {
    startingCash: number;
    feeBps: number;
    slippageBps: number;
    allowShorts: boolean;
  };
  risk: {
    riskPerTradePct: number;
    maxPositionPct: number;
    maxOpenPositions: number;
    maxDailyLossPct: number;
    stopoutCooldownMin: number;
  };

  dataDir: string;
}

/** Load `.env` from the working directory if it exists (Node's built-in loader). */
export function loadDotEnv(path = ".env"): void {
  const full = resolve(path);
  if (existsSync(full)) process.loadEnvFile(full);
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const str = (key: string, fallback = ""): string => {
    const value = env[key];
    return value === undefined || value.trim() === "" ? fallback : value.trim();
  };
  const num = (key: string, fallback: number): number => {
    const raw = str(key);
    if (raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${key} must be a number, got "${raw}"`);
    return value;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const raw = str(key).toLowerCase();
    if (raw === "") return fallback;
    if (["1", "true", "on", "yes"].includes(raw)) return true;
    if (["0", "false", "off", "no"].includes(raw)) return false;
    throw new Error(`${key} must be on/off, got "${raw}"`);
  };
  const list = (key: string, fallback: string): string[] =>
    str(key, fallback)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const mode = str("BOT_MODE", "signals");
  if (mode !== "signals" && mode !== "autonomous") {
    throw new Error(`BOT_MODE must be "signals" or "autonomous", got "${mode}"`);
  }

  const symbols = list("SYMBOLS", "BTCUSDT,ETHUSDT,SOLUSDT").map((s) => s.toUpperCase());
  const timeframes = list("TIMEFRAMES", "15m,1h").map((tf) => {
    if (!(TIMEFRAMES as readonly string[]).includes(tf)) {
      throw new Error(`Unsupported timeframe "${tf}". Use one of: ${TIMEFRAMES.join(" ")}`);
    }
    return tf as Timeframe;
  });
  if (symbols.length === 0) throw new Error("SYMBOLS is empty");
  if (timeframes.length === 0) throw new Error("TIMEFRAMES is empty");

  const baseProvider = str("LLM_PROVIDER", "anthropic").toLowerCase();
  const baseModel = str("LLM_MODEL", defaultModel(baseProvider));
  const baseMaxTokens = num("LLM_MAX_TOKENS", 16000);
  const llm = {} as Record<LlmRole, RoleLlmConfig>;
  for (const role of LLM_ROLES) {
    const p = role.toUpperCase();
    const provider = str(`${p}_PROVIDER`, baseProvider).toLowerCase();
    llm[role] = {
      provider,
      model: str(`${p}_MODEL`, provider === baseProvider ? baseModel : defaultModel(provider)),
      apiKey: str(`${p}_API_KEY`, str("LLM_API_KEY")) || undefined,
      baseUrl: str(`${p}_BASE_URL`, str("LLM_BASE_URL")) || undefined,
      effort: str(`${p}_EFFORT`, str("LLM_EFFORT")) || undefined,
      maxTokens: num(`${p}_MAX_TOKENS`, baseMaxTokens),
    };
  }

  const fallbacks = str("ANTHROPIC_FALLBACKS", "auto");
  if (!["auto", "default", "off"].includes(fallbacks)) {
    throw new Error(`ANTHROPIC_FALLBACKS must be auto, default or off`);
  }

  const groupMode = str("TELEGRAM_GROUP_MODE", "explicit") as SourceMode;
  if (!["explicit", "candidate", "ignore"].includes(groupMode)) {
    throw new Error("TELEGRAM_GROUP_MODE must be explicit, candidate or ignore");
  }

  const digest = str("DAILY_DIGEST_TIME", "21:00");
  if (!/^\d{2}:\d{2}$/.test(digest)) throw new Error("DAILY_DIGEST_TIME must be HH:MM (UTC)");

  const config: Config = {
    mode,
    symbols,
    timeframes,
    marketDataUrl: str("MARKET_DATA_URL", "https://data-api.binance.vision").replace(/\/$/, ""),
    llm,
    anthropicFallbacks: fallbacks as Config["anthropicFallbacks"],
    maxWorkers: num("MAX_WORKERS", 4),
    maxToolStepsPerTurn: num("MAX_TOOL_STEPS", 24),
    routerCompactTokens: num("ROUTER_COMPACT_TOKENS", 120_000),
    workerCompactTokens: num("WORKER_COMPACT_TOKENS", 150_000),
    minSetupScore: num("MIN_SETUP_SCORE", 0.55),
    targetR: num("TARGET_R", 2),
    speculative: bool("SPECULATIVE", true),
    nearSetupAtr: num("NEAR_SETUP_ATR", 0.35),
    maxSpeculative: num("MAX_SPECULATIVE", 2),
    notifyChannels: list("NOTIFY_CHANNELS", "console"),
    imWordLimit: num("IM_WORD_LIMIT", 100),
    console: bool("CONSOLE_CHANNEL", true),
    telegram: {
      token: str("TELEGRAM_BOT_TOKEN") || undefined,
      chatIds: list("TELEGRAM_CHAT_IDS", ""),
      groupMode,
    },
    discordWebhookUrl: str("DISCORD_WEBHOOK_URL") || undefined,
    webhookUrl: str("WEBHOOK_URL") || undefined,
    httpPort: num("HTTP_PORT", 8787),
    httpToken: str("HTTP_TOKEN") || undefined,
    dailyDigestTime: digest,
    watchdogIntervalSec: num("WATCHDOG_INTERVAL_SEC", 300),
    workerStallMin: num("WORKER_STALL_MIN", 20),
    endpoint: str("EXECUTION_ENDPOINT", "local"),
    endpointToken: str("ENDPOINT_TOKEN") || undefined,
    endpointPort: num("ENDPOINT_PORT", 8788),
    paper: {
      startingCash: num("PAPER_STARTING_CASH", 10_000),
      feeBps: num("PAPER_FEE_BPS", 10),
      slippageBps: num("PAPER_SLIPPAGE_BPS", 5),
      allowShorts: bool("ALLOW_SHORTS", false),
    },
    risk: {
      riskPerTradePct: num("RISK_PER_TRADE_PCT", 0.5),
      maxPositionPct: num("MAX_POSITION_PCT", 20),
      maxOpenPositions: num("MAX_OPEN_POSITIONS", 3),
      maxDailyLossPct: num("MAX_DAILY_LOSS_PCT", 3),
      stopoutCooldownMin: num("STOPOUT_COOLDOWN_MIN", 60),
    },
    dataDir: str("DATA_DIR", "./data"),
  };

  if (config.maxWorkers < 1) throw new Error("MAX_WORKERS must be at least 1");
  if (config.risk.riskPerTradePct <= 0 || config.risk.riskPerTradePct > 5) {
    throw new Error("RISK_PER_TRADE_PCT must be in (0, 5]");
  }
  return config;
}

function defaultModel(provider: string): string {
  switch (provider) {
    case "anthropic":
      return "claude-opus-5-5";
    case "mock":
      return "mock";
    default:
      return "";
  }
}
