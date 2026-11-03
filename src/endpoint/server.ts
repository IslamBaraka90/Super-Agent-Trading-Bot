import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { ExecutionEndpoint } from "./endpoint.js";
import { logger } from "../util/log.js";

const log = logger("endpoint-server");

/** Serve an ExecutionEndpoint as `POST /rpc {method, params}` with a bearer token. */
export function serveEndpoint(endpoint: ExecutionEndpoint, port: number, token?: string): Server {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/rpc") return send(404, { ok: false, error: "not found" });
    if (token && !validToken(req.headers.authorization, token)) return send(401, { ok: false, error: "unauthorized" });

    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) return send(413, { ok: false, error: "body too large" });
    }
    try {
      const { method, params } = JSON.parse(raw) as { method: string; params?: Record<string, unknown> };
      const result = await endpoint.handle(method, params ?? {});
      send(200, { ok: true, result });
    } catch (err) {
      send(200, { ok: false, error: (err as Error).message });
    }
  });
  server.listen(port, () => log.info(`execution endpoint listening on :${port}${token ? "" : " (NO TOKEN - local use only)"}`));
  return server;
}

function validToken(header: string | undefined, token: string): boolean {
  const given = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
