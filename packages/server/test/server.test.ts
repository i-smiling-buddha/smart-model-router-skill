import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonStore, ProviderRegistry } from "@smr/core";
import { createContext, handleMcpMessage, runMcpStdio, runOperation, startHttpServer, OPERATIONS } from "../src/index.js";
import type { Server } from "node:http";

const ctx = () => createContext({}, { store: new JsonStore(), providers: new ProviderRegistry([]) });

describe("Common API", () => {
  it("validates input and runs the lifecycle", async () => {
    const c = ctx();
    await expect(runOperation(c, "smr_route", {})).rejects.toThrow(/task/);
    await expect(runOperation(c, "nope", {})).rejects.toThrow(/unknown operation/);
    const t: any = await runOperation(c, "smr_task_start", { task: "add a dark mode toggle", host: "claude-code" });
    expect(t.hostModel).toBe("sonnet");
    await runOperation(c, "smr_task_attempt", { taskId: t.taskId, model: "sonnet", passed: false });
    const r: any = await runOperation(c, "smr_task_attempt", { taskId: t.taskId, model: "sonnet", passed: false, reason: "tests" });
    expect(r.next).toMatchObject({ action: "escalate", hostModel: "opus" });
    const h: any = await runOperation(c, "smr_task_handoff", { taskId: t.taskId, constraints: ["keep API"] });
    expect(h.handoff).toContain("keep API");
    const rep: any = await runOperation(c, "smr_report", {});
    expect(rep.models[0].attempts).toBe(2);
  });

  it("packs context inside the project only, and exposes learning", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "smr-proj-"));
    writeFileSync(join(dir, "auth.ts"), "export function login() { /* jwt token */ }");
    writeFileSync(join(dir, ".env"), "SECRET=abc123456789");
    const c = createContext({}, { store: new JsonStore(), providers: new ProviderRegistry([]), cwd: dir });
    const r: any = await runOperation(c, "smr_pack_context", { task: "fix login jwt" });
    expect(r.files.map((f: any) => f.path)).toEqual(["auth.ts"]);
    expect(r.markdown).not.toContain("abc123456789");
    await expect(runOperation(c, "smr_pack_context", { task: "x", dirs: ["../.."] })).rejects.toThrow(/outside project/);
    expect(await runOperation(c, "smr_learn", {})).toEqual([]);
  });

  it("every operation has a JSON schema for MCP", () => {
    for (const o of OPERATIONS) expect(o.jsonSchema).toMatchObject({ type: "object" });
  });
});

describe("HTTP server", () => {
  let server: Server;
  let url: string;
  beforeAll(async () => ({ server, url } = await startHttpServer(ctx(), 0)));
  afterAll(() => server.close());

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(url + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as any };
  };

  it("serves health, routing and the task lifecycle on 127.0.0.1", async () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect((await call("GET", "/health")).json.ok).toBe(true);
    expect((await call("POST", "/tasks/route", { task: "fix typo in README", host: "claude-code" })).json.decision.hostModel).toBe("haiku");
    const t = (await call("POST", "/tasks", { task: "add a dark mode toggle" })).json;
    const a = await call("POST", `/tasks/${t.taskId}/attempts`, { model: "sonnet", passed: true });
    expect(a.json.next.action).toBe("complete");
    expect((await call("GET", `/tasks/${t.taskId}`)).json.task.status).toBe("completed");
    expect((await call("GET", "/models")).json.length).toBeGreaterThan(2);
  });

  it("returns proper errors", async () => {
    expect((await call("POST", "/tasks/route", {})).status).toBe(400);
    expect((await call("GET", "/tasks/nope/next")).status).toBe(404);
    expect((await call("GET", "/nothing")).status).toBe(404);
    const bad = await fetch(url + "/tasks/route", { method: "POST", body: "{not json" });
    expect(bad.status).toBe(400);
  });

  it("serves the HTML dashboard", async () => {
    const res = await fetch(url + "/dashboard");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toContain("Smart Model Router");
  });

  it("enforces SMR_API_TOKEN when set", async () => {
    process.env.SMR_API_TOKEN = "secret-token";
    const { server: s2, url: u2 } = await startHttpServer(ctx(), 0);
    try {
      expect((await fetch(u2 + "/models")).status).toBe(401);
      expect((await fetch(u2 + "/models", { headers: { authorization: "Bearer secret-token" } })).status).toBe(200);
      expect((await fetch(u2 + "/health")).status).toBe(200);
    } finally {
      delete process.env.SMR_API_TOKEN;
      s2.close();
    }
  });
});

describe("MCP server", () => {
  it("handles initialize / tools/list / tools/call / errors", async () => {
    const c = ctx();
    const init: any = await handleMcpMessage(c, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities.tools).toBeDefined();
    expect(await handleMcpMessage(c, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    const list: any = await handleMcpMessage(c, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.result.tools.map((t: any) => t.name)).toContain("smr_task_start");
    const callRes: any = await handleMcpMessage(c, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "smr_route", arguments: { task: "fix typo in README" } } });
    expect(JSON.parse(callRes.result.content[0].text).decision.selectedModel).toBe("anthropic/claude-haiku-5-5");
    const bad: any = await handleMcpMessage(c, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "smr_route", arguments: {} } });
    expect(bad.result.isError).toBe(true);
    const unknown: any = await handleMcpMessage(c, { jsonrpc: "2.0", id: 5, method: "resources/list" });
    expect(unknown.error.code).toBe(-32601);
  });

  it("speaks newline-delimited JSON-RPC over stdio, in order", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: any[] = [];
    output.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => lines.push(JSON.parse(l))));
    const done = runMcpStdio(ctx(), input, output);
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n");
    input.write("garbage\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    input.end();
    await done;
    expect(lines).toHaveLength(3);
    // replies to requests keep request order
    expect(lines.filter((l) => l.id !== null).map((l) => l.id)).toEqual([1, 2]);
    expect(lines.find((l) => l.id === null).error.code).toBe(-32700);
    expect(lines.find((l) => l.id === 1).result).toEqual({});
    expect(lines.find((l) => l.id === 2).result.tools.length).toBe(OPERATIONS.length);
  });
});
