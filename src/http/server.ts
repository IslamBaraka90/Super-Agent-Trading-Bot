import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Runtime } from "../runtime.js";
import type { HttpChannel } from "../channels/outbound.js";
import { renderRecall } from "../context/render.js";
import { logger } from "../util/log.js";

const log = logger("http");

/**
 * Local status API and HTTP chat channel. Binds to 127.0.0.1 unless HTTP_HOST
 * says otherwise; set HTTP_TOKEN before exposing it anywhere.
 *
 *   GET  /status        overview: mode, workers, signals, account
 *   GET  /objects/:id   recall any object (Chain of Recall over HTTP)
 *   POST /message       {"text": "...", "conversation"?: "..."} - talk to the agent
 *   GET  /outbox        the agent's replies on the http channel
 */
export function serveHttp(rt: Runtime, port: number, token?: string, host = process.env.HTTP_HOST ?? "127.0.0.1"): Server {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body, null, 2));
    };
    if (token && !validToken(req.headers.authorization, token)) return send(401, { error: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://local");
    try {
      if (req.method === "GET" && url.pathname === "/status") return send(200, await rt.overview());
      if (req.method === "GET" && url.pathname.startsWith("/objects/")) {
        const id = decodeURIComponent(url.pathname.slice("/objects/".length));
        return send(200, { id, text: renderRecall(rt.store, id, Number(url.searchParams.get("offset") ?? 0), 20_000) });
      }
      if (req.method === "GET" && url.pathname === "/outbox") {
        const channel = rt.hub.get("http") as HttpChannel | undefined;
        return send(200, channel?.outbox ?? []);
      }
      if (req.method === "POST" && url.pathname === "/message") {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 100_000) return send(413, { error: "body too large" });
        }
        const body = JSON.parse(raw || "{}") as { text?: string; conversation?: string; author?: string };
        if (!body.text?.trim()) return send(400, { error: "text is required" });
        rt.ingestChat({
          channel: "http",
          conversation: body.conversation ?? "owner",
          author: body.author ?? "owner",
          text: body.text,
          explicit: true,
          isGroup: false,
          allowed: true,
        });
        return send(202, { accepted: true, replies: "GET /outbox" });
      }
      send(404, { error: "not found" });
    } catch (err) {
      send(500, { error: (err as Error).message });
    }
  });
  server.listen(port, host, () => log.info(`status API on http://${host}:${port}${token ? "" : " (no HTTP_TOKEN)"}`));
  return server;
}

function validToken(header: string | undefined, token: string): boolean {
  const given = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
