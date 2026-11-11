import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { OPERATIONS, runOperation, type ApiContext } from "./api.js";

/**
 * MCP server over stdio (newline-delimited JSON-RPC 2.0).
 * Works with any MCP host: Claude Code, OpenCode, Codex, Cursor, VS Code agents...
 *
 * Implements: initialize, notifications/initialized, ping, tools/list, tools/call.
 * stdout carries protocol messages ONLY — all logging goes to stderr.
 */

const SERVER_INFO = { name: "smart-model-router", version: "0.4.0" };
const DEFAULT_PROTOCOL = "2025-06-18";

interface RpcRequest { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any }

export async function handleMcpMessage(ctx: ApiContext, msg: RpcRequest): Promise<object | undefined> {
  const isNotification = msg.id === undefined || msg.id === null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });

  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: msg.params?.protocolVersion ?? DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Smart Model Router: call smr_task_start before delegating work, smr_verify after it, and follow the returned next.action (retry / escalate / stop / complete).",
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: OPERATIONS.map((o) => ({ name: o.name, description: o.description, inputSchema: o.jsonSchema })) });
    case "tools/call": {
      const name = msg.params?.name;
      try {
        const result = await runOperation(ctx, name, msg.params?.arguments ?? {});
        return ok({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: toStructured(result) });
      } catch (e) {
        // Tool errors are results (isError) so the model can read and react to them.
        return ok({ content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      return isNotification ? undefined : err(-32601, `Method not found: ${msg.method}`);
  }
}

function toStructured(r: unknown): Record<string, unknown> | undefined {
  if (r && typeof r === "object" && !Array.isArray(r)) return r as Record<string, unknown>;
  return { result: r };
}

export function runMcpStdio(ctx: ApiContext, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const write = (o: object) => output.write(JSON.stringify(o) + "\n");
  let queue = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: RpcRequest;
    try { msg = JSON.parse(line); } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    // Keep responses in order; one slow tool call doesn't reorder replies.
    queue = queue.then(async () => {
      try {
        const res = await handleMcpMessage(ctx, msg);
        if (res) write(res);
      } catch (e) {
        write({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: (e as Error).message } });
      }
    });
  });
  return new Promise((resolve) => rl.on("close", () => { queue.then(() => resolve()); }));
}
