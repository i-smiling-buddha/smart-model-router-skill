/**
 * End-to-end: the built CLI as a user runs it (apps/cli/dist, or the release bundle when
 * SMR_BIN points at it). Run `npm run build` first. Cross-platform: CI runs this on
 * Windows, macOS and Linux.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const BIN = process.env.SMR_BIN ?? join(ROOT, "apps", "cli", "dist", "index.js");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const smr = (args: string[], opts: { cwd?: string; input?: string } = {}) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: opts.cwd, input: opts.input, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const tmp = () => mkdtempSync(join(tmpdir(), "smr-e2e-"));

describe.skipIf(!existsSync(BIN))("CLI end-to-end", () => {
  it("--version matches the package version", () => {
    expect(smr(["--version"]).out.trim()).toBe(VERSION);
  });

  it("route → json", () => {
    const r = JSON.parse(smr(["route", "fix typo in README", "--host", "claude-code", "--json"]).out);
    expect(r.decision.hostModel).toBe("haiku");
  });

  it.each(["claude-code", "opencode", "codex"])("init %s for windows and posix, then doctor passes", (host) => {
    for (const platform of ["posix", "windows"]) {
      const dir = tmp();
      expect(smr(["init", host, dir, "--platform", platform]).code).toBe(0);
      const d = JSON.parse(smr(["doctor", "--json"], { cwd: dir }).out);
      const failures = d.checks.filter((c: any) => c.level === "fail" && !(c.name.endsWith("MCP") && platform !== (process.platform === "win32" ? "windows" : "posix")));
      expect(failures).toEqual([]);
    }
  });

  it("init never overwrites existing files", () => {
    const dir = tmp();
    writeFileSync(join(dir, "AGENTS.md"), "mine");
    const out = smr(["init", "codex", dir]).out;
    expect(out).toMatch(/= AGENTS\.md/);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("mine");
  });

  it("task lifecycle: start → fail → fail → escalate → pass → report", () => {
    const dir = tmp();
    const t = JSON.parse(smr(["task", "start", "add a dark mode toggle", "--host", "claude-code", "--json"], { cwd: dir }).out);
    smr(["task", "attempt", t.taskId, "--model", "sonnet", "--fail"], { cwd: dir });
    const esc = JSON.parse(smr(["task", "attempt", t.taskId, "--model", "sonnet", "--fail", "--json"], { cwd: dir }).out);
    expect(esc.next).toMatchObject({ action: "escalate", hostModel: "opus" });
    const done = JSON.parse(smr(["task", "attempt", t.taskId, "--model", "opus", "--pass", "--json"], { cwd: dir }).out);
    expect(done.next.action).toBe("complete");
    expect(JSON.parse(smr(["report", "--json"], { cwd: dir }).out).models.length).toBe(2);
  });

  it("MCP over stdio: initialize + tools/list", () => {
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ].map((m) => JSON.stringify(m)).join("\n") + "\n";
    const r = smr(["mcp"], { cwd: tmp(), input });
    const lines = r.out.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    expect(lines[0].result.serverInfo.version).toBe(VERSION);
    expect(lines[1].result.tools.length).toBeGreaterThanOrEqual(12);
    expect(r.err).toBe(""); // nothing but protocol on stdout, nothing noisy on stderr
  });

  it("hook: captures transcript tokens, never fails the host", () => {
    const dir = tmp();
    const transcript = join(dir, "agent.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { id: "m", model: "claude-haiku-5-5", usage: { input_tokens: 40, output_tokens: 2 } } }) + "\n");
    expect(smr(["hook", "subagent-stop"], { cwd: dir, input: JSON.stringify({ agent_type: "smr-fast", agent_transcript_path: transcript }) }).code).toBe(0);
    expect(smr(["hook", "subagent-stop"], { cwd: dir, input: "garbage" }).code).toBe(0);
    const t = JSON.parse(smr(["task", "start", "fix typo in README", "--json"], { cwd: dir }).out);
    const a = JSON.parse(smr(["task", "attempt", t.taskId, "--model", "haiku", "--pass", "--json"], { cwd: dir }).out);
    expect(a).toBeTruthy();
    expect(JSON.parse(smr(["report", "--json"], { cwd: dir }).out).models[0].inputTokens).toBe(40);
  });

  it("serve: health + dashboard over HTTP, then shuts down", async () => {
    const child = spawn(process.execPath, [BIN, "serve", "--port", "0"], { cwd: tmp() });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("serve did not start")), 15_000);
        child.stdout.on("data", (d) => {
          const m = String(d).match(/http:\/\/127\.0\.0\.1:\d+/);
          if (m) { clearTimeout(t); resolve(m[0]); }
        });
      });
      expect((await (await fetch(url + "/health")).json()).ok).toBe(true);
      expect(await (await fetch(url + "/dashboard")).text()).toContain("Smart Model Router");
    } finally {
      child.kill();
    }
  });

  it("bench refuses to run model code without --allow-code-exec; simulated bench works", () => {
    const dir = tmp();
    const r = smr(["bench"], { cwd: dir });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/allow-code-exec/);
    const s = JSON.parse(smr(["bench", "--simulate", "--seed", "5", "--json"], { cwd: dir }).out);
    expect(s.simulated).toBe(true);
    expect(s.strategies.length).toBe(3);
  });
});
