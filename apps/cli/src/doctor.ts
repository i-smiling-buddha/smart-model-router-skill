import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { ModelRegistry, SmrConfig } from "@smr/core";

/**
 * `smr doctor` — the first thing to run when something doesn't work (especially on Windows).
 * Never prints secret VALUES — only whether an environment variable is set.
 */

export interface DoctorCheck { name: string; level: "ok" | "warn" | "fail" | "info"; detail: string }

const KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY"];

function which(cmd: string): string | undefined {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).find(Boolean);
  } catch {
    return undefined;
  }
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function runDoctor(cfg: SmrConfig, storeDir: string, configPath: string, registry: ModelRegistry, cwd = process.cwd()): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, level: DoctorCheck["level"], detail: string) => checks.push({ name, level, detail });

  // Runtime
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 20) add("Node.js", "fail", `v${process.versions.node} — SMR needs Node 20 or newer (Windows: winget install OpenJS.NodeJS.LTS)`);
  else if (major === 22 && minor < 5 || major < 22) add("Node.js", "warn", `v${process.versions.node} — works; Node ≥ 22.5 enables the faster SQLite log`);
  else add("Node.js", "ok", `v${process.versions.node} on ${process.platform}/${process.arch}`);

  let sqlite = false;
  try {
    const original = process.emitWarning;
    process.emitWarning = (() => {}) as typeof process.emitWarning;
    try { createRequire(import.meta.url)("node:sqlite"); sqlite = true; } finally { process.emitWarning = original; }
  } catch { /* not available */ }
  add("Execution log", sqlite ? "ok" : "info", sqlite ? "SQLite (node:sqlite)" : "JSON file fallback (node:sqlite not available)");

  // PATH — hosts launch "smr" by name
  const onPath = which("smr");
  add("smr on PATH", onPath ? "ok" : "warn", onPath ?? "not found — hosts can't launch it. Install globally (npm install -g …) or run: npm link -w @smr/cli");

  // Config + registry
  if (existsSync(configPath)) {
    try { readJson(configPath); add("Config", "ok", configPath); } catch (e) { add("Config", "fail", `${configPath}: ${(e as Error).message}`); }
  } else add("Config", "info", "no smr.config.json here — defaults are used");
  const priced = registry.all().filter((m) => m.pricing).length;
  add("Registry", "ok", `${registry.available().length} available model(s)${cfg.registryPath ? ` from ${cfg.registryPath}` : " (built-in defaults)"}`);
  add("Pricing", priced ? "ok" : "info", priced ? `${priced} model(s) priced — costs shown in USD` : "no prices set — costs shown in relative units (see smr.registry.example.json)");

  // Store writable
  try {
    mkdirSync(storeDir, { recursive: true });
    accessSync(storeDir, constants.W_OK);
    add("Log folder", "ok", `${storeDir} is writable`);
  } catch (e) {
    add("Log folder", "fail", `${storeDir}: ${(e as Error).message}`);
  }

  // API keys (names only, never values)
  const keys = KEY_VARS.filter((k) => !!process.env[k]);
  add("API keys", keys.length ? "ok" : "info", keys.length ? `set: ${keys.join(", ")}` : "none set — only needed for smr exec, smr bench and --llm (hosts use their own login)");

  // Integrations in this folder
  const win = process.platform === "win32";
  const mcpUsesCmd = (cmd: unknown, args: unknown) => !win || cmd === "cmd" || (Array.isArray(cmd) && cmd[0] === "cmd");
  const claudeAgents = existsSync(join(cwd, ".claude/agents")) ? readdirSync(join(cwd, ".claude/agents")).filter((f) => /^smr-.*\.md$/.test(f)) : [];
  if (claudeAgents.length || existsSync(join(cwd, ".claude/skills/smart-model-router"))) {
    add("Claude Code", claudeAgents.length === 3 ? "ok" : "warn", `${claudeAgents.length}/3 smr subagents, skill ${existsSync(join(cwd, ".claude/skills/smart-model-router/SKILL.md")) ? "present" : "missing"}`);
    try {
      const s = existsSync(join(cwd, ".claude/settings.json")) ? readJson(join(cwd, ".claude/settings.json")) : {};
      const hooked = JSON.stringify(s.hooks?.SubagentStop ?? []).includes("smr hook subagent-stop");
      add("Claude Code hook", hooked ? "ok" : "warn", hooked ? "SubagentStop token capture on" : "SubagentStop hook missing in .claude/settings.json — tokens won't be captured automatically");
    } catch (e) { add("Claude Code hook", "fail", `.claude/settings.json: ${(e as Error).message}`); }
    try {
      const m = existsSync(join(cwd, ".mcp.json")) ? readJson(join(cwd, ".mcp.json")) : undefined;
      const smr = m?.mcpServers?.smr;
      if (!smr) add("Claude Code MCP", "info", "no smr entry in .mcp.json (optional — the skill also works with the CLI)");
      else add("Claude Code MCP", mcpUsesCmd(smr.command, smr.args) ? "ok" : "fail", mcpUsesCmd(smr.command, smr.args) ? "smr MCP server configured" : 'on Windows use "command": "cmd", "args": ["/c", "smr", "mcp"] (re-run smr init on Windows)');
    } catch (e) { add("Claude Code MCP", "fail", `.mcp.json: ${(e as Error).message}`); }
  }
  const ocAgents = existsSync(join(cwd, ".opencode/agents")) ? readdirSync(join(cwd, ".opencode/agents")).filter((f) => /^smr-.*\.md$/.test(f)) : [];
  if (ocAgents.length) {
    add("OpenCode", ocAgents.length === 4 ? "ok" : "warn", `${ocAgents.length}/4 smr agents`);
    try {
      const smr = existsSync(join(cwd, "opencode.json")) ? readJson(join(cwd, "opencode.json")).mcp?.smr : undefined;
      if (smr) add("OpenCode MCP", mcpUsesCmd(smr.command, undefined) ? "ok" : "fail", mcpUsesCmd(smr.command, undefined) ? "smr MCP server configured" : 'on Windows use "command": ["cmd", "/c", "smr", "mcp"]');
    } catch (e) { add("OpenCode MCP", "fail", `opencode.json: ${(e as Error).message}`); }
  }
  const cxAgents = existsSync(join(cwd, ".codex/agents")) ? readdirSync(join(cwd, ".codex/agents")).filter((f) => /^smr-.*\.toml$/.test(f)) : [];
  if (cxAgents.length) {
    add("Codex", cxAgents.length === 3 ? "ok" : "warn", `${cxAgents.length}/3 smr agents — verify their model names match your Codex account`);
    const toml = existsSync(join(cwd, ".codex/config.toml")) ? readFileSync(join(cwd, ".codex/config.toml"), "utf8") : "";
    if (toml.includes("[mcp_servers.smr]")) {
      const ok = !win || /command\s*=\s*"cmd"/.test(toml);
      add("Codex MCP", ok ? "ok" : "fail", ok ? "smr MCP server configured" : 'on Windows use command = "cmd", args = ["/c", "smr", "mcp"]');
    }
  }
  if (!claudeAgents.length && !ocAgents.length && !cxAgents.length) add("Integrations", "info", "none in this folder — run smr init <claude-code|opencode|codex>");
  return checks;
}
