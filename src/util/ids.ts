import { randomBytes } from "node:crypto";

/**
 * Short, prefixed, human-readable ids (`wrk_k3x9a2f1`). Models read and copy
 * these back into tool calls, so they stay short and unambiguous.
 */
export function newId(prefix: string): string {
  const n = randomBytes(5).readUIntBE(0, 5);
  return `${prefix}_${n.toString(36).padStart(8, "0")}`;
}
