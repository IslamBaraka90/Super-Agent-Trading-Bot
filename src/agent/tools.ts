import { z } from "zod";
import type { JsonSchema, ToolCall, ToolResult, ToolSpec } from "../llm/types.js";
import type { Store } from "../state/store.js";
import { newId } from "../util/ids.js";
import { spill } from "../util/text.js";
import { compactJson } from "../context/render.js";

export interface ToolContext {
  sessionId: string;
  role: string;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  run(input: z.infer<S>, ctx: ToolContext): unknown;
}

export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

// Each tool's input type differs; the registry validates with the tool's own schema before calling run.
export type AnyTool = ToolDef<any>;

/** Output above this is spilled into the object store behind a recall pointer. */
export const TOOL_OUTPUT_CAP = 6_000;

/** Validate inputs, run, and spill long outputs. Tool errors go back to the model, never up the stack. */
export class ToolRegistry {
  private readonly byName = new Map<string, AnyTool>();
  private readonly cachedSpecs: ToolSpec[];

  constructor(
    tools: AnyTool[],
    private readonly store?: Store,
  ) {
    for (const t of tools) {
      if (this.byName.has(t.name)) throw new Error(`Duplicate tool ${t.name}`);
      this.byName.set(t.name, t);
    }
    // Computed once: a session's tool list must not change between requests.
    this.cachedSpecs = tools.map((t) => ({ name: t.name, description: t.description, parameters: toSchema(t.schema) }));
  }

  specs(): ToolSpec[] {
    return this.cachedSpecs;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.byName.get(call.name);
    if (!tool) return { callId: call.id, name: call.name, content: `Unknown tool "${call.name}".`, isError: true };
    if ("__invalid_json" in call.input) {
      return { callId: call.id, name: call.name, content: "Tool arguments were not valid JSON. Send them again.", isError: true };
    }
    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i: { path: PropertyKey[]; message: string }) => `${i.path.map(String).join(".") || "input"}: ${i.message}`)
        .join("; ");
      return { callId: call.id, name: call.name, content: `Invalid arguments: ${issues}`, isError: true };
    }
    try {
      const output = await tool.run(parsed.data, ctx);
      return { callId: call.id, name: call.name, content: this.format(output) };
    } catch (err) {
      return { callId: call.id, name: call.name, content: `Error: ${(err as Error).message}`, isError: true };
    }
  }

  private format(output: unknown): string {
    const text = typeof output === "string" ? output : output === undefined ? "ok" : compactJson(output);
    if (text.length <= TOOL_OUTPUT_CAP || !this.store) return text;
    const id = newId("out");
    this.store.putObject({ id, kind: "tool_output", summary: text.slice(0, 120), body: { text } });
    return spill(text, TOOL_OUTPUT_CAP, id);
  }
}

function toSchema(schema: z.ZodObject): JsonSchema {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
