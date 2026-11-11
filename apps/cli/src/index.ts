#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  anthropicBackend,
  classifyTask,
  classifyWithFallback,
  decideNext,
  detectChecks,
  evaluate,
  executeTask,
  formatCost,
  loadConfig as loadSmrConfig,
  openStore,
  ProviderRegistry,
  providerBackend,
  readTranscript,
  registryFor,
  Router,
  SMR_AGENT_MODELS,
  TaskSession,
  usageFromTranscript,
  DEFAULT_POLICY,
  type AttemptRecord,
  type EscalationDecision,
  type ExecutionStore,
  type HostId,
  type RoutingMode,
  type SmrConfig,
  type SubagentStopInput,
  type TaskClassification,
} from "@smr/core";
import { createContext, runMcpStdio, startHttpServer } from "@smr/server";

const HELP = `smr — Smart Model Router  (use the cheapest model that can reliably do the job)

Routing:
  smr route "<task>"     [--mode smart|economy|quality] [--host claude-code|opencode|generic] [--llm] [--json]
  smr classify "<task>"  [--llm] [--json]
  smr escalate "<task>"  --from <model> [--attempts N] [--reason "..."]       (stateless)
  smr models             [--json]

Task lifecycle (logged in .smr/, drives retry + escalation from real history):
  smr task start "<task>"                         → task id + model to use
  smr task attempt <id> --model <m> --pass|--fail [--reason "..."] [--input-tokens N] [--output-tokens N]
  smr task next <id>                              → retry / escalate / stop / complete
  smr task handoff <id> [--constraint "..."]...   → compact handoff for the next model
  smr task show <id>

Quality:
  smr verify [<id>] [--task "<task>"] [--model <m>] [--cwd dir]
      runs static/functional checks the task needs; with <id> + --model it records the attempt

Direct execution (custom agents / non-agentic tasks — calls the provider API itself):
  smr exec "<task>" [--system "..."] [--json]      route → call → verify → escalate, usage logged
      keys from env: ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY; Ollama: OLLAMA_HOST

Universal integration:
  smr mcp                                         MCP server over stdio (Claude Code, OpenCode, Codex, Cursor...)
  smr serve [--port 4317]                         local HTTP API on 127.0.0.1 (optional SMR_API_TOKEN)
  smr hook subagent-stop                          Claude Code SubagentStop hook: captures subagent token usage

Reporting / setup:
  smr report [--json]
  smr init <claude-code|opencode|codex> [targetDir]

Options:
  --registry <file>   custom registry JSON (merged over defaults)
  --config <file>     config file (default ./smr.config.json)
  --llm               refine low-confidence classifications with a cheap model (needs ANTHROPIC_API_KEY)
  --json              machine-readable output (for skills / agents)
`;

type Flags = Record<string, string | boolean | string[]>;

const REPEATABLE = new Set(["constraint", "file"]);

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value: string | true = next !== undefined && !next.startsWith("--") ? (i++, next) : true;
      if (REPEATABLE.has(key) && typeof value === "string") flags[key] = [...((flags[key] as string[]) ?? []), value];
      else flags[key] = value;
    } else positional.push(a);
  }
  return { positional, flags };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : undefined);

function loadConfig(flags: Flags): SmrConfig {
  return loadSmrConfig(str(flags.config) ?? "smr.config.json");
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  if (!cmd || cmd === "help" || cmd === "--help" || flags.help) { console.log(HELP); return; }

  const cfg = loadConfig(flags);
  const registry = registryFor(cfg, str(flags.registry));
  const mode = (str(flags.mode) ?? cfg.mode ?? "smart") as RoutingMode;
  const host = (str(flags.host) ?? cfg.host ?? "generic") as HostId;
  const json = !!flags.json;
  const routerOpts = { mode, host, costCeilingUsd: cfg.costCeilingUsd, minSuccessProbability: cfg.minSuccessProbability };
  const policy = {
    maxRetriesPerModel: cfg.maxRetriesPerModel ?? DEFAULT_POLICY.maxRetriesPerModel,
    maxEscalations: cfg.maxEscalations ?? DEFAULT_POLICY.maxEscalations,
    costCeilingUsd: cfg.costCeilingUsd,
  };
  const out = (data: unknown, human: () => string) => console.log(json ? JSON.stringify(data, null, 2) : human());

  let store: ExecutionStore | undefined;
  const getStore = () => (store ??= openStore(resolve(cfg.storeDir ?? ".smr")));

  const classify = async (text: string): Promise<TaskClassification> => {
    const useLlm = !!flags.llm || !!cfg.llmClassifier?.enabled;
    if (!useLlm) return classifyTask(text);
    let backend;
    const llmModel = cfg.llmClassifier?.model ?? "claude-haiku-5-5";
    try { backend = llmModel.includes("/") ? providerBackend(ProviderRegistry.defaults(), llmModel) : anthropicBackend({ model: llmModel }); }
    catch (e) { console.error(`smr: ${(e as Error).message} — using rule-based classification`); return classifyTask(text); }
    return classifyWithFallback(text, { backend, threshold: cfg.llmClassifier?.threshold, cache: getStore() });
  };

  try {
    switch (cmd) {
      case "classify": {
        const c = await classify(need(positional.join(" ")));
        out(c, () => describeClassification(c));
        return;
      }
      case "route": {
        const c = await classify(need(positional.join(" ")));
        const d = new Router(registry).route(c, routerOpts);
        out({ classification: c, decision: d }, () =>
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
        const c = classifyTask(need(positional.join(" ")));
        const from = str(flags.from);
        if (!from) fail("--from <model> is required");
        const n = num(flags.attempts) ?? 1;
        const reason = str(flags.reason) ?? "verification failed";
        const fromId = registry.require(from).id;
        const attempts: AttemptRecord[] = Array.from({ length: n }, () => ({ modelId: fromId, passed: false, failureReason: reason }));
        const d = decideNext(c, attempts, registry, policy, { host });
        out(d, () => describeNext(d));
        return;
      }
      case "models": {
        const models = registry.all();
        out(models, () =>
          models.map((m) =>
            `${m.available ? "●" : "○"} ${m.id.padEnd(30)} ${m.tier.padEnd(9)} cost×${String(m.relativeCost).padEnd(3)} ` +
            `code ${m.scores.coding} reason ${m.scores.reasoning} speed ${m.scores.speed}  [${m.scoreSource}]` +
            (m.pricing ? "" : "  pricing: not set")).join("\n"));
        return;
      }
      case "task": {
        const sub = positional[0];
        const session = new TaskSession(getStore(), registry, policy, host, routerOpts);
        if (sub === "start") {
          const text = need(positional.slice(1).join(" "));
          const t = session.start(text, await classify(text));
          out({ taskId: t.id, decision: t.decision, classification: t.classification }, () =>
            [`task ${t.id}`, `→ ${t.decision.hostModel}   ${t.decision.routingReason}`,
             `  verify: ${t.decision.verificationLevels.join(", ")}`,
             `  next: run it, then  smr task attempt ${t.id} --model ${t.decision.hostModel} --pass|--fail`].join("\n"));
          return;
        }
        const id = positional[1];
        if (!id) fail(`usage: smr task ${sub ?? "<start|attempt|next|handoff|show>"} <id>`);
        if (sub === "attempt") {
          const model = str(flags.model);
          if (!model) fail("--model <m> is required");
          if (!flags.pass && !flags.fail) fail("--pass or --fail is required");
          const r = session.recordAttempt(id, {
            model, passed: !!flags.pass && !flags.fail, failureReason: str(flags.reason),
            inputTokens: num(flags["input-tokens"]), outputTokens: num(flags["output-tokens"]),
          });
          out(r, () => `recorded attempt #${r.attempt.id} (${r.attempt.modelId}: ${r.attempt.passed ? "pass" : "fail"})\n${describeNext(r.next)}`);
          return;
        }
        if (sub === "next") { const d = session.next(id); out(d, () => describeNext(d)); return; }
        if (sub === "handoff") {
          const md = session.handoff(id, { constraints: flags.constraint as string[] | undefined, relevantFiles: flags.file as string[] | undefined });
          out({ taskId: id, handoff: md }, () => md);
          return;
        }
        if (sub === "show") {
          const rec = getStore().getTask(id);
          if (!rec) fail(`unknown task id: ${id}`);
          out(rec, () =>
            [`${rec.task.id}  [${rec.task.status}]  ${rec.task.category}/c${rec.task.complexity}/${rec.task.riskLevel}`,
             `  ${rec.task.text}`,
             `  routed → ${rec.task.decision.hostModel}`,
             ...rec.attempts.map((a) => `  #${a.id} ${a.modelId.padEnd(30)} ${a.passed ? "pass" : "FAIL"} ${(a.failureReason ?? "").replace(/\s+/g, " ").slice(0, 100)}`)].join("\n"));
          return;
        }
        fail(`unknown task subcommand "${sub}"`);
      }
      case "verify": {
        const id = positional[0];
        const rec = id ? getStore().getTask(id) : undefined;
        if (id && !rec) fail(`unknown task id: ${id}`);
        const c = rec?.task.classification ?? classifyTask(need(str(flags.task) ?? ""));
        const cwd = resolve(str(flags.cwd) ?? ".");
        const checks = cfg.checks ?? detectChecks(cwd);
        const result = await evaluate(c, { cwd, checks });
        let next: EscalationDecision | undefined;
        const model = str(flags.model);
        if (rec && model) {
          const session = new TaskSession(getStore(), registry, policy, host, routerOpts);
          next = session.recordAttempt(rec.task.id, {
            model, passed: result.passed, failureReason: result.failureSummary?.slice(0, 500),
          }).next;
        }
        out({ ...result, next }, () =>
          [`${result.passed ? "✓ PASSED" : "✗ FAILED"}  (levels: ${result.levelsRequested.join(", ")})`,
           ...result.results.map((r) => `  ${r.passed ? "✓" : "✗"} ${r.level.padEnd(10)} ${r.name.padEnd(10)} ${(r.durationMs / 1000).toFixed(1)}s${r.timedOut ? " (timed out)" : ""}`),
           ...result.skipped.map((s) => `  - skipped ${s.name}: ${s.reason}`),
           ...(checks.length === 0 ? ["  (no checks found — add \"checks\" to smr.config.json)"] : []),
           ...(result.semanticChecklist.length ? ["  semantic checklist (host/human):", ...result.semanticChecklist.map((s) => `   [ ] ${s}`)] : []),
           ...(result.failureSummary ? ["", result.failureSummary] : []),
           ...(next ? ["", describeNext(next)] : [])].join("\n"));
        if (!result.passed) process.exitCode = 2;
        return;
      }
      case "report": {
        const s = getStore();
        const models = s.modelStats();
        const tasks = s.listTasks(10);
        const cats = s.categoryStats();
        out({ backend: s.backend, models, categories: cats, recentTasks: tasks.map(({ classification, decision, ...t }) => ({ ...t, routedTo: decision.selectedModel })) }, () => {
          if (models.length === 0 && tasks.length === 0) return `No tasks logged yet (${s.backend}). Start with: smr task start "<task>"`;
          return [`SMR report  (store: ${s.backend})`, "",
            "Model                            attempts  pass%   tokens(in/out)      cost",
            ...models.map((m) =>
              `${m.modelId.padEnd(32)} ${String(m.attempts).padStart(8)}  ${String(Math.round(m.passRate * 100)).padStart(4)}%   ` +
              `${`${m.inputTokens}/${m.outputTokens}`.padEnd(18)}  ${m.costUsd !== null ? "$" + m.costUsd.toFixed(4) : m.costUnits.toFixed(4) + " units"}`),
            "", "Pass rate by category:",
            ...cats.map((c) => `  ${c.category.padEnd(14)} ${c.modelId.padEnd(30)} ${Math.round(c.passRate * 100)}% of ${c.attempts}`),
            "", "Recent tasks:",
            ...tasks.map((t) => `  ${t.id}  ${t.status.padEnd(9)} → ${t.decision.hostModel.padEnd(8)} ${t.text.slice(0, 60)}`)].join("\n");
        });
        return;
      }
      case "exec": {
        const text = need(positional.join(" "));
        const r = await executeTask(text, await classify(text), {
          store: getStore(), providers: ProviderRegistry.defaults(), registry, policy, host, router: routerOpts,
          system: str(flags.system),
          onEvent: json ? undefined : (e) => {
            if (e.type === "attempt") console.error(`  ${e.passed ? "✓" : "✗"} ${e.modelId}  in ${e.inputTokens} / out ${e.outputTokens}${e.reason ? "  " + e.reason : ""}`);
            if (e.type === "error") console.error(`  ✗ ${e.modelId}  ${e.reason}`);
          },
        });
        out(r, () => r.output ?? `smr: task ${r.taskId} ${r.status} — ${r.reason}`);
        if (!r.output) process.exitCode = 2;
        return;
      }
      case "mcp": {
        // stdout belongs to the protocol — never console.log here.
        await runMcpStdio(createContext(cfg, { registry }));
        return;
      }
      case "serve": {
        const port = num(flags.port) ?? cfg.server?.port ?? 4317;
        const { url } = await startHttpServer(createContext(cfg, { registry }), port);
        console.log(`SMR API listening on ${url}  (Ctrl+C to stop)${process.env.SMR_API_TOKEN ? "  [token auth on]" : ""}`);
        await new Promise(() => {}); // run until killed
        return;
      }
      case "hook": {
        // Hooks must NEVER break the host session: always exit 0, report problems on stderr.
        if (positional[0] !== "subagent-stop") { console.error(`smr hook: unknown hook "${positional[0]}"`); return; }
        try {
          const input = JSON.parse((await readStdin()) || "{}") as SubagentStopInput;
          const agent = input.agent_type ?? "";
          const transcript = readTranscript(input.agent_transcript_path);
          const usage = transcript ? usageFromTranscript(transcript) : undefined;
          const modelRef = (usage?.model && registry.get(usage.model)?.id) || SMR_AGENT_MODELS[agent];
          if (!modelRef || !usage || (!usage.inputTokens && !usage.outputTokens)) return;
          new TaskSession(getStore(), registry, policy, host, routerOpts).addPendingUsage(modelRef, usage.inputTokens, usage.outputTokens);
        } catch (e) {
          console.error(`smr hook: ${(e as Error).message}`);
        }
        return;
      }
      case "init": {
        const target = positional[0];
        if (target !== "claude-code" && target !== "opencode" && target !== "codex") fail("usage: smr init <claude-code|opencode|codex> [targetDir]");
        const dest = resolve(positional[1] ?? ".");
        const here = dirname(fileURLToPath(import.meta.url));
        const src = join(here, "..", "..", "..", "integrations", target);
        if (!existsSync(src)) fail(`integration templates not found at ${src}`);
        const created: string[] = [];
        const skipped: string[] = [];
        const walk = (rel: string) => {
          const from = join(src, rel);
          if (statSync(from).isDirectory()) { for (const n of readdirSync(from)) walk(join(rel, n)); return; }
          const to = join(dest, rel);
          if (existsSync(to)) { skipped.push(rel); return; }
          mkdirSync(dirname(to), { recursive: true });
          cpSync(from, to);
          created.push(rel);
        };
        walk("");
        console.log(`SMR ${target} integration → ${dest}`);
        created.forEach((f) => console.log(`  + ${f}`));
        skipped.forEach((f) => console.log(`  = ${f}  (already exists — not overwritten; merge the SMR part by hand)`));
        console.log(`\nNext: make "smr" available on PATH (npm link -w @smr/cli), and add ".smr/" to .gitignore.`);
        return;
      }
      default:
        fail(`unknown command "${cmd}"\n\n${HELP}`);
    }
  } finally {
    store?.close();
  }
}

function describeClassification(c: TaskClassification): string {
  return [`Category:   ${c.category}${c.subcategory ? " / " + c.subcategory : ""}`,
    `Complexity: ${c.complexity} (${["", "simple", "moderate", "complex", "critical"][c.complexity]})`,
    `Risk:       ${c.riskLevel}`,
    `Confidence: ${c.confidence}`,
    `Signals:    ${c.signals.join("; ")}`].join("\n");
}

function describeNext(d: EscalationDecision): string {
  return `${d.action.toUpperCase()}${d.hostModel ? " → " + d.hostModel : ""}\n  ${d.reason}`;
}

function need(task: string): string {
  if (!task.trim()) fail('task text required, e.g. smr route "fix the login bug"');
  return task;
}

function fail(msg: string): never {
  console.error(`smr: ${msg}`);
  process.exit(1);
}

main().catch((e) => fail((e as Error).message));
