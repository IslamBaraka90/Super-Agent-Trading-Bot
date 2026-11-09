import { z } from "zod";
import { ToolRegistry, defineTool } from "../agent/tools.js";
import {
  killSwitchTool,
  listPoliciesTool,
  listWorkersTool,
  messageWorkerTool,
  recallTool,
  removePolicyTool,
  setPolicyTool,
  statusOverviewTool,
  stopWorkerTool,
} from "../agent/common-tools.js";
import type { Runtime } from "../runtime.js";
import { TIMEFRAMES } from "../config.js";

/**
 * Router tools: interaction and dispatch only. Deliberately no market, order
 * or shell tools - the Router coordinates and never executes (design §2.1).
 */
export function buildRouterTools(rt: Runtime): ToolRegistry {
  const dispatch = defineTool({
    name: "dispatch_worker",
    description:
      "Start a background worker for one task (analyse a setup, manage a position, answer a research question, compile the digest). " +
      "Returns the worker id. The worker reports back to you.",
    schema: z.object({
      task: z.string().min(10).describe("What the worker must do and what to report back. Be specific."),
      symbol: z.string().optional(),
      timeframe: z.enum(TIMEFRAMES).optional(),
      threads: z
        .array(z.string())
        .optional()
        .describe("Thread keys the worker should own, e.g. mkt:BTCUSDT:1h or pos:pos_ab12cd34"),
      trigger_ids: z.array(z.string()).optional().describe("Triggers the task is about; they are shown to the worker"),
    }),
    run: ({ task, symbol, timeframe, threads, trigger_ids }) => {
      const id = rt.pool.dispatch({
        task,
        symbol,
        timeframe,
        threads: threads ?? [],
        triggerIds: trigger_ids ?? [],
        kind: "task",
      });
      return `Dispatched ${id}.`;
    },
  });

  const reply = defineTool({
    name: "reply",
    description: "Reply to a person on the channel (and target) their message came from.",
    schema: z.object({
      channel: z.string(),
      target: z.string().optional().describe("Copy the trigger's target attribute exactly. Omit it when the trigger has none."),
      text: z.string().min(1),
    }),
    run: async ({ channel, target, text }) => {
      const id = await rt.hub.send(channel, text, target, "router");
      return `Sent (${id}).`;
    },
  });

  const notify = defineTool({
    name: "notify",
    description: `Send a notification to the owner's notification channels (${rt.config.notifyChannels.join(", ")}) or a subset of them.`,
    schema: z.object({ text: z.string().min(1), channels: z.array(z.string()).optional() }),
    run: async ({ text, channels }) => {
      const result = await rt.hub.broadcast(text, channels ?? rt.config.notifyChannels, "router");
      if (result.sent.length === 0) throw new Error(`Not sent. ${result.failed.join("; ")}`);
      return `Sent to ${result.sent.join(", ")}${result.failed.length ? `; failed: ${result.failed.join("; ")}` : ""}.`;
    },
  });

  const ignore = defineTool({
    name: "ignore",
    description: "Record that triggers need no action, with a short reason.",
    schema: z.object({ trigger_ids: z.array(z.string()).min(1), reason: z.string() }),
    run: ({ trigger_ids, reason }) => {
      for (const id of trigger_ids) {
        rt.store.setTriggerStatus(id, "ignored", reason);
        rt.store.updateObject(id, { status: "ignored" });
      }
      return `Ignored ${trigger_ids.length}.`;
    },
  });

  return new ToolRegistry(
    [
      dispatch,
      listWorkersTool(rt),
      messageWorkerTool(rt),
      stopWorkerTool(rt),
      reply,
      notify,
      ignore,
      recallTool(rt),
      statusOverviewTool(rt),
      setPolicyTool(rt),
      removePolicyTool(rt),
      listPoliciesTool(rt),
      killSwitchTool(rt),
    ],
    rt.store,
  );
}
