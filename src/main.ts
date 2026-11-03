import { loadConfig, loadDotEnv } from "./config.js";
import { Runtime } from "./runtime.js";
import { serveHttp } from "./http/server.js";
import { logger } from "./util/log.js";

loadDotEnv();
const log = logger("main");

let config;
try {
  config = loadConfig();
} catch (err) {
  log.error(`configuration error: ${(err as Error).message}`);
  process.exit(1);
}

const runtime = new Runtime(config);
const http = config.httpPort > 0 ? serveHttp(runtime, config.httpPort, config.httpToken) : undefined;

runtime.start().catch((err) => {
  log.error("failed to start", err);
  process.exit(1);
});

let stopping = false;
const shutdown = async () => {
  if (stopping) process.exit(1);
  stopping = true;
  log.info("shutting down (state is saved continuously; restart resumes)");
  http?.close();
  await runtime.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
