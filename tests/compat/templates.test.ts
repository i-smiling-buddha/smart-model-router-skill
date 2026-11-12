/**
 * Integration compatibility: every host template is structurally valid and consistent with
 * the registry, the router and each other. Catches broken frontmatter, bad JSON/TOML,
 * hook matchers that don't match agent names, and model aliases the registry doesn't know.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY, routeTask } from "@smr/core";
import { adaptTemplate } from "../../apps/cli/src/templates.js";

const ROOT = join(import.meta.dirname, "..", "..");
const I = (...p: string[]) => join(ROOT, "integrations", ...p);
const read = (p: string) => readFileSync(p, "utf8");

function frontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error("missing frontmatter");
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) out[kv[1]!] = kv[2]!.trim();
  }
  return out;
}

/** Minimal TOML reader for our templates: strings, """multiline""", arrays of strings, [tables]. */
function toml(src: string): Record<string, any> {
  const root: Record<string, any> = {};
  let table = root;
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    const t = line.match(/^\[([\w.-]+)\]$/);
    if (t) { table = t[1]!.split(".").reduce((o: any, k) => (o[k] ??= {}), root); continue; }
    const kv = line.match(/^([\w-]+)\s*=\s*(.*)$/);
    if (!kv) throw new Error(`bad TOML line ${i + 1}: ${line}`);
    const [, key, raw] = kv as unknown as [string, string, string];
    if (raw.startsWith('"""')) {
      const first = raw.slice(3);
      if (first.endsWith('"""')) { table[key] = first.slice(0, -3); continue; }
      const buf: string[] = [first];
      for (;;) {
        i++;
        if (i >= lines.length) throw new Error(`unterminated """ for ${key}`);
        const l = lines[i]!;
        if (l.trimEnd().endsWith('"""')) { buf.push(l.trimEnd().slice(0, -3)); break; }
        buf.push(l);
      }
      table[key] = buf.join("\n").trim();
    } else table[key] = JSON.parse(raw);
  }
  return root;
}

const aliases = (host: string) => new Set(DEFAULT_REGISTRY.models.map((m) => m.hostAliases[host]).filter(Boolean));

describe("Claude Code templates", () => {
  const agents = readdirSync(I("claude-code/.claude/agents"));

  it("subagents have name = filename, a description, and a known model alias", () => {
    expect(agents.sort()).toEqual(["smr-architect.md", "smr-builder.md", "smr-fast.md"]);
    for (const f of agents) {
      const fm = frontmatter(read(I("claude-code/.claude/agents", f)));
      expect(fm.name).toBe(f.replace(/\.md$/, ""));
      expect(fm.description!.length).toBeGreaterThan(20);
      expect(aliases("claude-code").has(fm.model!)).toBe(true);
    }
  });

  it("skill has name + description within limits", () => {
    const fm = frontmatter(read(I("claude-code/.claude/skills/smart-model-router/SKILL.md")));
    expect(fm.name).toBe("smart-model-router");
    expect(fm.description!.length).toBeGreaterThan(30);
    expect(fm.description!.length).toBeLessThanOrEqual(1024);
  });

  it("SubagentStop hook matcher matches exactly the SMR agents", () => {
    const s = JSON.parse(read(I("claude-code/.claude/settings.json")));
    const matcher = new RegExp(s.hooks.SubagentStop[0].matcher);
    for (const f of agents) expect(matcher.test(f.replace(/\.md$/, ""))).toBe(true);
    expect(matcher.test("Explore")).toBe(false);
    expect(s.hooks.SubagentStop[0].hooks[0].command).toBe("smr hook subagent-stop");
  });

  it(".mcp.json launches smr mcp", () => {
    expect(JSON.parse(read(I("claude-code/.mcp.json"))).mcpServers.smr).toEqual({ command: "smr", args: ["mcp"] });
  });

  it("routing for claude-code always lands on an installed subagent model", () => {
    const models = new Set(agents.map((f) => frontmatter(read(I("claude-code/.claude/agents", f))).model));
    for (const t of ["fix typo in README", "add a dark mode toggle", "security audit of payment gateway integration"]) {
      expect(models.has(routeTask(t, { host: "claude-code" }).decision.hostModel)).toBe(true);
    }
  });
});

describe("OpenCode templates", () => {
  it("agents: description, mode, provider/model known to the registry; exactly one primary", () => {
    const files = readdirSync(I("opencode/.opencode/agents"));
    const modes = files.map((f) => {
      const fm = frontmatter(read(I("opencode/.opencode/agents", f)));
      expect(fm.description!.length).toBeGreaterThan(20);
      expect(["primary", "subagent"]).toContain(fm.mode);
      expect(aliases("opencode").has(fm.model!)).toBe(true);
      return fm.mode;
    });
    expect(modes.filter((m) => m === "primary")).toHaveLength(1);
  });

  it("opencode.json declares the local smr MCP server", () => {
    const c = JSON.parse(read(I("opencode/opencode.json")));
    expect(c.mcp.smr).toMatchObject({ type: "local", command: ["smr", "mcp"], enabled: true });
  });
});

describe("Codex templates", () => {
  it("TOML agents have the required keys and name = filename", () => {
    const files = readdirSync(I("codex/.codex/agents"));
    expect(files.sort()).toEqual(["smr-architect.toml", "smr-builder.toml", "smr-fast.toml"]);
    for (const f of files) {
      const a = toml(read(I("codex/.codex/agents", f)));
      expect(a.name).toBe(f.replace(/\.toml$/, ""));
      for (const k of ["description", "developer_instructions", "model"]) expect(String(a[k] ?? "").length).toBeGreaterThan(2);
      expect(["low", "medium", "high"]).toContain(a.model_reasoning_effort);
    }
  });

  it("registry codex aliases point at installed agents", () => {
    const names = new Set(readdirSync(I("codex/.codex/agents")).map((f) => f.replace(/\.toml$/, "")));
    for (const a of aliases("codex")) expect(names.has(a as string)).toBe(true);
  });

  it("config.toml declares the smr MCP server; skill + AGENTS.md present", () => {
    expect(toml(read(I("codex/.codex/config.toml"))).mcp_servers.smr).toEqual({ command: "smr", args: ["mcp"] });
    expect(frontmatter(read(I("codex/.agents/skills/smart-model-router/SKILL.md"))).name).toBe("smart-model-router");
    expect(read(I("codex/AGENTS.md"))).toMatch(/smr_task_start/);
  });
});

describe("Windows adaptation", () => {
  it("wraps every MCP launcher in cmd /c and keeps files valid", () => {
    const mcp = JSON.parse(adaptTemplate(".mcp.json", read(I("claude-code/.mcp.json")), "win32"));
    expect(mcp.mcpServers.smr).toEqual({ command: "cmd", args: ["/c", "smr", "mcp"] });
    const oc = JSON.parse(adaptTemplate("opencode.json", read(I("opencode/opencode.json")), "win32"));
    expect(oc.mcp.smr.command).toEqual(["cmd", "/c", "smr", "mcp"]);
    expect(toml(adaptTemplate(".codex\\config.toml", read(I("codex/.codex/config.toml")), "win32")).mcp_servers.smr).toEqual({ command: "cmd", args: ["/c", "smr", "mcp"] });
  });

  it("leaves POSIX files and hook commands untouched", () => {
    const raw = read(I("claude-code/.mcp.json"));
    expect(adaptTemplate(".mcp.json", raw, "linux")).toBe(raw);
    const settings = read(I("claude-code/.claude/settings.json"));
    expect(adaptTemplate(".claude/settings.json", settings, "win32")).toBe(settings);
  });
});

describe("Every config file parses", () => {
  it.each(["claude-code", "opencode", "codex"])("%s/smr.config.json", (host) => {
    const c = JSON.parse(read(I(host, "smr.config.json")));
    expect(c.host).toBe(host);
    expect(["smart", "economy", "quality"]).toContain(c.mode);
  });
});
