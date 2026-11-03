import { join } from "node:path";
import { loadConfig, loadDotEnv } from "./config.js";
import { ExecutionEndpoint } from "./endpoint/endpoint.js";
import { serveEndpoint } from "./endpoint/server.js";
import { logger } from "./util/log.js";

/**
 * Standalone execution endpoint daemon. Run it on the machine that should hold
 * the broker ledger, then point the agent at it with
 * EXECUTION_ENDPOINT=http://<host>:<ENDPOINT_PORT>.
 */
loadDotEnv();
const log = logger("endpoint-main");
const config = loadConfig();

const broker = (process.env.BROKER ?? "paper").toLowerCase();
if (broker !== "paper") {
  log.error(`BROKER=${broker} is not supported. This project trades paper accounts only.`);
  process.exit(1);
}

const endpoint = new ExecutionEndpoint({
  marketDataUrl: config.marketDataUrl,
  ledgerPath: join(config.dataDir, "paper.db"),
  symbols: config.symbols,
  paper: config.paper,
  risk: config.risk,
});
endpoint.start();
const server = serveEndpoint(endpoint, config.endpointPort, config.endpointToken);

const shutdown = () => {
  log.info("shutting down");
  server.close();
  endpoint.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
