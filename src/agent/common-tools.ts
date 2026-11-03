import { z } from "zod";
import { defineTool } from "./tools.js";
import { renderRecall } from "../context/render.js";
import type { Runtime } from "../runtime.js";
import { fmtPct } from "../util/text.js";

/** Tools shared by the Router and the Watchdog. */

export const recallTool = (rt: Runtime) =>
  defineTool({
    name: "recall",
    description:
      "Read any object by id (trg_, wrk_, sig_, pos_, job_, pol_, msg_, spc_, out_, or a thread key such as mkt:BTCUSDT:1h). " +
      "Shows its body, the objects it links to and the objects linking to it. Use offset to continue a cut-off body.",
    schema: z.object({ id: z.string(), offset: z.number().int().min(0).optional() }),
    run: ({ id, offset }) => renderRecall(rt.store, id.trim(), offset ?? 0),
  });

export const listWorkersTool = (rt: Runtime) =>
  defineTool({
    name: "list_workers",
    description: "List workers that are queued, running or waiting for events, with their task and the threads they own.",
    schema: z.object({ include_finished_minutes: z.number().int().min(0).max(1440).optional() }),
    run: ({ include_finished_minutes }) => {
      const workers = rt.pool.list(include_finished_minutes ?? 0);
      if (workers.length === 0) return "No active workers.";
      return workers
        .map((w) => `${w.id} [${w.status}] ${w.task}${w.threads.length ? ` | threads: ${w.threads.join(", ")}` : ""} | last progress ${w.idleMinutes} min ago`)
        .join("\n");
    },
  });

export const messageWorkerTool = (rt: Runtime) =>
  defineTool({
    name: "message_worker",
    description: "Send an instruction or new information to a running worker.",
    schema: z.object({ worker_id: z.string(), text: z.string().min(1) }),
    run: ({ worker_id, text }) =>
      rt.pool.message(worker_id, text) ? `Delivered to ${worker_id}.` : `${worker_id} is not active.`,
  });

export const stopWorkerTool = (rt: Runtime) =>
  defineTool({
    name: "stop_worker",
    description: "Stop a worker. Positions it opened stay open; dispatch another worker to manage them if needed.",
    schema: z.object({ worker_id: z.string(), reason: z.string() }),
    run: ({ worker_id, reason }) => (rt.pool.stop(worker_id, reason) ? `Stopped ${worker_id}.` : `${worker_id} is not active.`),
  });

export const killSwitchTool = (rt: Runtime) =>
  defineTool({
    name: "kill_switch",
    description: "Turn the kill switch on (blocks every new paper entry) or off. Existing positions keep their stops.",
    schema: z.object({ on: z.boolean(), reason: z.string() }),
    run: async ({ on, reason }) => {
      const result = await rt.endpoint.call<{ killSwitch: boolean }>("risk.killSwitch", { on, reason });
      return `Kill switch is now ${result.killSwitch ? "ON" : "OFF"}.`;
    },
  });

export const setPolicyTool = (rt: Runtime) =>
  defineTool({
    name: "set_policy",
    description:
      "Add a plain-language filter policy (for example: ignore SOLUSDT 1m setups). The event filter applies it to every candidate from now on.",
    schema: z.object({ text: z.string().min(5), expires_in_hours: z.number().positive().max(24 * 90).optional() }),
    run: ({ text, expires_in_hours }, ctx) => {
      const policy = rt.policies.add(text, ctx.role, expires_in_hours);
      return `Policy ${policy.id} added${policy.expiresAt ? `, expires ${new Date(policy.expiresAt).toISOString().slice(0, 16)}Z` : ""}.`;
    },
  });

export const removePolicyTool = (rt: Runtime) =>
  defineTool({
    name: "remove_policy",
    description: "Remove a filter policy by id (pol_...).",
    schema: z.object({ policy_id: z.string() }),
    run: ({ policy_id }) => (rt.policies.remove(policy_id) ? `Removed ${policy_id}.` : `No policy ${policy_id}.`),
  });

export const listPoliciesTool = (rt: Runtime) =>
  defineTool({
    name: "list_policies",
    description: "List the active filter policies.",
    schema: z.object({}),
    run: () => rt.policies.render(),
  });

export const statusOverviewTool = (rt: Runtime) =>
  defineTool({
    name: "status_overview",
    description: "Read-only overview: paper account, open positions, open signals, workers, kill switch. For answering status questions.",
    schema: z.object({}),
    run: async () => {
      const lines: string[] = [`mode: ${rt.config.mode}`];
      try {
        const acct = await rt.endpoint.call<Record<string, number | boolean>>("broker.account");
        lines.push(
          `paper equity ${Number(acct.equity).toFixed(2)} (day ${fmtPct(Number(acct.dayPnlPct))}), cash ${Number(acct.cash).toFixed(2)}, ` +
            `open positions ${acct.openPositions}, kill switch ${acct.killSwitch ? "ON" : "off"}`,
        );
        const positions = await rt.endpoint.call<Record<string, unknown>[]>("broker.positions", { status: "open" });
        for (const p of positions) {
          lines.push(
            `${p.id} ${p.side} ${p.symbol} entry ${p.entryPrice} stop ${p.stop} target ${p.target ?? "-"} unrealized ${Number(p.unrealized ?? 0).toFixed(2)} (${Number(p.unrealizedR ?? 0).toFixed(2)}R)`,
          );
        }
      } catch (err) {
        lines.push(`account unavailable: ${(err as Error).message}`);
      }
      const open = rt.signals.open();
      lines.push(`open signals: ${open.length ? open.map((s) => `${s.id} ${s.summary}`).join("; ") : "none"}`);
      const card = rt.signals.scorecard(Date.now() - 7 * 86_400_000);
      lines.push(`signals last 7d: ${card.resolved} resolved, win rate ${(card.winRate * 100).toFixed(0)}%, avg ${card.avgR.toFixed(2)}R`);
      lines.push(`workers: ${rt.pool.list(0).length} active`);
      return lines.join("\n");
    },
  });
