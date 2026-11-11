#!/usr/bin/env node
import { cpSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyTask,
  decideNext,
  formatCost,
  ModelRegistry,
  Router,
  DEFAULT_POLICY,
  type AttemptRecord,
  type HostId,
  type RoutingMode,
} from "@smr/core";

const HELP = `smr — Smart Model Router  (use the cheapest model that can reliably do the job)

Usage:
  smr route "<task>"     [--mode smart|economy|quality] [--host claude-code|opencode|generic] [--json]
  smr classify "<task>"  [--json]
  smr escalate "<task>"  --from <model> [--attempts N] [--reason "..."] [--host ...] [--json]
  smr models             [--json]
  smr init <claude-code|opencode> [targetDir]

Options:
  --registry <file>   Use a custom registry JSON (merged over defaults)
  --config <file>     Config file (default: ./smr.config.json if present)
  --json              Machine-readable output (for skills / agents)
`;

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd?: string; positional: string[]; flags: Flags } {
  const [cmd, ...rest] = argv;
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; } else flags[key] = true;
    } else positional.push(a);
  }
  return { cmd, positional, flags };
}

interface SmrConfig {
  mode?: RoutingMode;
  host?: HostId;
  registryPath?: string;
  maxRetriesPerModel?: number;
  maxEscalations?: number;
  costCeilingUsd?: number;
  minSuccessProbability?: number;
}

function loadConfig(flags: Flags): SmrConfig {
  const path = typeof flags.config === "string" ? flags.config : "smr.config.json";
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as SmrConfig;
}

function loadRegistry(flags: Flags, cfg: SmrConfig): ModelRegistry {
  const p = (typeof flags.registry === "string" && flags.registry) || cfg.registryPath;
  return p ? ModelRegistry.fromFile(p, { merge: true }) : new ModelRegistry();
}

const out = (flags: Flags, json: unknown, human: () => string) =>
  console.log(flags.json ? JSON.stringify(json, null, 2) : human());

function main(): void {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  if (!cmd || cmd === "help" || flags.help) { console.log(HELP); return; }
  const cfg = loadConfig(flags);
  const registry = loadRegistry(flags, cfg);
  const mode = ((flags.mode as string) ?? cfg.mode ?? "smart") as RoutingMode;
  const host = ((flags.host as string) ?? cfg.host ?? "generic") as HostId;
  const taskText = positional.join(" ");

  switch (cmd) {
    case "classify": {
      const c = classifyTask(need(taskText));
      out(flags, c, () =>
        [`Category:   ${c.category}${c.subcategory ? " / " + c.subcategory : ""}`,
         `Complexity: ${c.complexity} (${["", "simple", "moderate", "complex", "critical"][c.complexity]})`,
         `Risk:       ${c.riskLevel}`,
         `Confidence: ${c.confidence}`,
         `Signals:    ${c.signals.join("; ")}`].join("\n"));
      return;
    }
    case "route": {
      const c = classifyTask(need(taskText));
      const d = new Router(registry).route(c, {
        mode, host,
        costCeilingUsd: cfg.costCeilingUsd,
        minSuccessProbability: cfg.minSuccessProbability,
      });
      out(flags, { classification: c, decision: d }, () =>
        [`→ ${d.hostModel}   (${d.selectedModel})`,
         `  ${d.routingReason}`,
         `  est. cost: ${formatCost(d.estimatedCost)}   verify: ${d.verificationLevels.join(", ") || "none"}`,
         `  fallback:  ${d.fallbackModels.join(" → ") || "none"}`,
         "",
         "  candidates:",
         ...d.candidates.map((x) =>
           x.rejectedReason
             ? `   ✗ ${x.modelId.padEnd(30)} ${x.rejectedReason}`
             : `   ${x.modelId === d.selectedModel ? "✓" : " "} ${x.modelId.padEnd(30)} score ${x.breakdown.total.toFixed(1).padStart(5)}  p=${Math.round(x.successProbability * 100)}%`)].join("\n"));
      return;
    }
    case "escalate": {
      const c = classifyTask(need(taskText));
      const from = flags.from;
      if (typeof from !== "string") fail("--from <model> is required");
      const n = Number(flags.attempts ?? 1);
      const reason = typeof flags.reason === "string" ? flags.reason : "verification failed";
      const fromId = registry.require(from).id;
      const attempts: AttemptRecord[] = Array.from({ length: n }, () => ({ modelId: fromId, passed: false, failureReason: reason }));
      const d = decideNext(c, attempts, registry, {
        ...DEFAULT_POLICY,
        maxRetriesPerModel: cfg.maxRetriesPerModel ?? DEFAULT_POLICY.maxRetriesPerModel,
        maxEscalations: cfg.maxEscalations ?? DEFAULT_POLICY.maxEscalations,
      }, { host });
      out(flags, d, () => `${d.action.toUpperCase()}${d.hostModel ? " → " + d.hostModel : ""}\n  ${d.reason}`);
      return;
    }
    case "models": {
      const models = registry.all();
      out(flags, models, () =>
        models.map((m) =>
          `${m.available ? "●" : "○"} ${m.id.padEnd(30)} ${m.tier.padEnd(9)} cost×${String(m.relativeCost).padEnd(3)} ` +
          `code ${m.scores.coding} reason ${m.scores.reasoning} speed ${m.scores.speed}  [${m.scoreSource}]` +
          (m.pricing ? "" : "  pricing: not set")).join("\n"));
      return;
    }
    case "init": {
      const target = positional[0] as "claude-code" | "opencode" | undefined;
      if (target !== "claude-code" && target !== "opencode") fail("usage: smr init <claude-code|opencode> [targetDir]");
      const dest = resolve(positional[1] ?? ".");
      const here = dirname(fileURLToPath(import.meta.url));
      const src = join(here, "..", "..", "..", "integrations", target);
      if (!existsSync(src)) fail(`integration templates not found at ${src}`);
      cpSync(src, dest, { recursive: true, force: false, errorOnExist: false });
      console.log(`Installed SMR ${target} integration into ${dest}`);
      return;
    }
    default:
      fail(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

function need(task: string): string {
  if (!task.trim()) fail('task text required, e.g. smr route "fix the login bug"');
  return task;
}

function fail(msg: string): never {
  console.error(`smr: ${msg}`);
  process.exit(1);
}

try {
  main();
} catch (e) {
  fail((e as Error).message);
}
