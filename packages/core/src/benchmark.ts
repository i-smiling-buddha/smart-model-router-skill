import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTask } from "./classifier.js";
import { DEFAULT_POLICY } from "./escalation.js";
import { executeTask, type Verifier } from "./executor.js";
import { estimateTokens } from "./optimizer.js";
import { ProviderRegistry, type ProviderAdapter } from "./providers.js";
import { ModelRegistry, tierRank } from "./registry.js";
import { successProbability } from "./router.js";
import { JsonStore, type AttemptRow, type ExecutionStore } from "./store.js";
import type { EscalationPolicy, ModelSpec, RoutingMode, TaskCategory, TaskClassification } from "./types.js";

/**
 * Benchmark Engine (blueprint §12): prove SMR saves money WITHOUT losing success.
 *
 * Every case runs under each strategy with a fresh, isolated log (no learning leakage):
 *   smr          — full routing + escalation
 *   single:<id>  — one model for everything (retries allowed, no escalation)
 *   best         — the strongest available model for everything
 *
 * "50% fewer tokens but 30% more failures" is a FAIL. The verdict checks both.
 */

export type VerifySpec =
  | { type: "contains"; values: string[]; all?: boolean; caseSensitive?: boolean }
  | { type: "regex"; pattern: string; flags?: string }
  | { type: "json"; requiredKeys?: string[] }
  | { type: "node-test"; test: string; timeoutMs?: number }
  | { type: "none" };

export interface BenchmarkCase { id: string; task: string; verify: VerifySpec; tags?: string[] }
export interface BenchmarkSuite { name: string; description?: string; cases: BenchmarkCase[] }

export type Strategy = { kind: "smr"; mode?: RoutingMode } | { kind: "single"; model: string } | { kind: "best" };

export const strategyName = (s: Strategy) => (s.kind === "single" ? `single:${s.model}` : s.kind === "smr" && s.mode && s.mode !== "smart" ? `smr:${s.mode}` : s.kind);

export function parseStrategy(s: string): Strategy {
  if (s === "smr" || s === "best") return { kind: s };
  if (s.startsWith("smr:")) return { kind: "smr", mode: s.slice(4) as RoutingMode };
  if (s.startsWith("single:")) return { kind: "single", model: s.slice(7) };
  throw new Error(`Unknown strategy "${s}". Use smr, smr:economy, best, or single:<model-id>`);
}

export interface CaseResult {
  caseId: string;
  strategy: string;
  category: TaskCategory;
  complexity: number;
  passed: boolean;
  attempts: number;
  modelsUsed: string[];
  finalModel?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  costUnits: number;
  durationMs: number;
  reason: string;
}

export interface StrategySummary {
  strategy: string;
  cases: number;
  passed: number;
  successRate: number;
  attempts: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  costUnits: number;
  avgDurationMs: number;
}

export interface Comparison {
  baseline: string;
  successDeltaPts: number;
  costDeltaPct: number;
  tokenDeltaPct: number;
  verdict: "pass" | "fail";
  why: string;
}

export interface BenchmarkReport {
  suite: string;
  startedAt: string;
  finishedAt: string;
  simulated: boolean;
  seed?: number;
  strategies: StrategySummary[];
  comparisons: Comparison[];
  results: CaseResult[];
  /** Per-case replay data so results can be imported into the main log for learning. */
  replay: { caseId: string; strategy: string; task: string; classification: TaskClassification; attempts: AttemptRow[] }[];
}

/* ------------------------------------------------------------------ */
/* Verifiers                                                           */
/* ------------------------------------------------------------------ */

export function extractCode(output: string): string {
  const blocks = [...output.matchAll(/```([\w+-]*)\n([\s\S]*?)```/g)];
  const js = blocks.find((b) => /^(js|javascript|mjs|node|ts|typescript)?$/i.test(b[1] ?? ""));
  return (js ?? blocks[0])?.[2] ?? output;
}

function runNode(file: string, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [file], { timeout: timeoutMs, maxBuffer: 1_000_000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stderr || stdout || (err?.message ?? "")).slice(-600) }));
  });
}

/**
 * Build a verifier from a spec. NOTE: "node-test" executes model-generated code on this
 * machine (in a temp dir, with a timeout). Only use benchmark suites you trust.
 */
export function verifierFor(spec: VerifySpec): Verifier {
  return async (output) => {
    if (/^\s*ESCALATE:/i.test(output)) return { passed: false, reason: "model was unable to complete (ESCALATE)" };
    switch (spec.type) {
      case "none":
        return output.trim() ? { passed: true } : { passed: false, reason: "empty response" };
      case "contains": {
        const hay = spec.caseSensitive ? output : output.toLowerCase();
        const hits = spec.values.filter((v) => hay.includes(spec.caseSensitive ? v : v.toLowerCase()));
        const ok = spec.all ? hits.length === spec.values.length : hits.length > 0;
        return ok ? { passed: true } : { passed: false, reason: `expected ${spec.all ? "all" : "one"} of: ${spec.values.join(", ")}` };
      }
      case "regex":
        return new RegExp(spec.pattern, spec.flags).test(output) ? { passed: true } : { passed: false, reason: `did not match /${spec.pattern}/` };
      case "json": {
        const m = output.match(/```(?:json)?\n([\s\S]*?)```/) ?? output.match(/(\{[\s\S]*\})/);
        try {
          const v = JSON.parse((m?.[1] ?? output).trim());
          const missing = (spec.requiredKeys ?? []).filter((k) => !(k in v));
          return missing.length ? { passed: false, reason: `missing keys: ${missing.join(", ")}` } : { passed: true };
        } catch {
          return { passed: false, reason: "not valid JSON" };
        }
      }
      case "node-test": {
        const dir = mkdtempSync(join(tmpdir(), "smr-bench-"));
        try {
          const file = join(dir, "solution.mjs");
          writeFileSync(file, `${extractCode(output)}\n\n// ---- benchmark test ----\n${spec.test}\n`);
          const r = await runNode(file, spec.timeoutMs ?? 10_000);
          return r.ok ? { passed: true } : { passed: false, reason: `test failed: ${r.out.replace(/\s+/g, " ").slice(0, 300)}` };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* Simulation (offline demo — clearly labelled, never a real result)  */
/* ------------------------------------------------------------------ */

function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const hash01 = (s: string) => parseInt(createHash("sha1").update(s).digest("hex").slice(0, 8), 16) / 0xffffffff;

/**
 * Simulated providers: each model's "true" skill = registry prior ± a fixed per
 * (model, category) offset, so the Learning Engine has something real-ish to learn.
 * Outputs are tagged SIMULATED and pass/fail is decided by the matching simulated verifier.
 */
export function simulatedProviders(registry: ModelRegistry, seed = 42): { providers: ProviderRegistry; verifier: (task: TaskClassification) => Verifier } {
  const rand = seeded(seed);
  const prefixes = [...new Set(registry.all().map((m) => m.id.split("/")[0]!))];
  const adapters: ProviderAdapter[] = prefixes.map((prefix) => ({
    id: prefix,
    async complete(req) {
      const id = `${prefix}/${req.model}`;
      const outputTokens = Math.round(300 + rand() * 1200);
      return { text: `SIMULATED:${id}`, model: req.model, usage: { inputTokens: estimateTokens(req.prompt) + 600, outputTokens } };
    },
  }));
  const trueP = (m: ModelSpec, t: TaskClassification) =>
    Math.min(0.99, Math.max(0.01, successProbability(m, t) + (hash01(`${seed}|${m.id}|${t.category}`) - 0.5) * 0.3));
  return {
    providers: new ProviderRegistry(adapters),
    verifier: (t) => async (output) => {
      const id = output.replace(/^SIMULATED:/, "");
      const m = registry.get(id);
      if (!m) return { passed: false, reason: "unknown model" };
      return rand() < trueP(m, t) ? { passed: true } : { passed: false, reason: "simulated failure" };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

function bestModel(registry: ModelRegistry): ModelSpec {
  const avg = (m: ModelSpec) => (m.scores.coding + m.scores.reasoning + m.scores.debugging) / 3;
  const av = registry.available();
  if (!av.length) throw new Error("No available models in the registry.");
  return av.sort((a, b) => tierRank(b) - tierRank(a) || avg(b) - avg(a))[0]!;
}

function registryForStrategy(registry: ModelRegistry, s: Strategy): ModelRegistry {
  if (s.kind === "smr") return registry;
  const m = s.kind === "best" ? bestModel(registry) : registry.require(s.model);
  return new ModelRegistry({ version: 1, models: [{ ...m, available: true }] });
}

export async function runBenchmark(
  suite: BenchmarkSuite,
  opts: {
    strategies: Strategy[];
    registry?: ModelRegistry;
    providers?: ProviderRegistry;
    policy?: EscalationPolicy;
    simulate?: { seed?: number };
    onProgress?: (r: CaseResult) => void;
  },
): Promise<BenchmarkReport> {
  const registry = opts.registry ?? new ModelRegistry();
  const sim = opts.simulate ? simulatedProviders(registry, opts.simulate.seed ?? 42) : undefined;
  const providers = sim?.providers ?? opts.providers ?? ProviderRegistry.defaults();
  const policy = opts.policy ?? DEFAULT_POLICY;
  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];
  const replay: BenchmarkReport["replay"] = [];

  for (const strategy of opts.strategies) {
    const reg = registryForStrategy(registry, strategy);
    const name = strategyName(strategy);
    for (const c of suite.cases) {
      const store: ExecutionStore = new JsonStore(); // isolated: no cross-case learning, fair comparison
      const cls = classifyTask(c.task);
      const t0 = Date.now();
      const r = await executeTask(c.task, cls, {
        store, providers, registry: reg, policy,
        router: { mode: strategy.kind === "smr" ? strategy.mode ?? "smart" : "smart" },
        verifier: sim ? sim.verifier(cls) : verifierFor(c.verify),
      });
      const attempts = store.getTask(r.taskId)!.attempts;
      const usdKnown = attempts.some((a) => a.costUsd !== undefined);
      const res: CaseResult = {
        caseId: c.id,
        strategy: name,
        category: cls.category,
        complexity: cls.complexity,
        passed: !!r.output,
        attempts: attempts.length,
        modelsUsed: [...new Set(attempts.map((a) => a.modelId))],
        finalModel: r.finalModel,
        inputTokens: attempts.reduce((s, a) => s + (a.inputTokens ?? 0), 0),
        outputTokens: attempts.reduce((s, a) => s + (a.outputTokens ?? 0), 0),
        costUsd: usdKnown ? attempts.reduce((s, a) => s + (a.costUsd ?? 0), 0) : null,
        costUnits: attempts.reduce((s, a) => s + (a.costUnits ?? 0), 0),
        durationMs: Date.now() - t0,
        reason: r.reason,
      };
      results.push(res);
      replay.push({ caseId: c.id, strategy: name, task: c.task, classification: cls, attempts });
      opts.onProgress?.(res);
    }
  }

  const strategies = opts.strategies.map((s) => summarize(strategyName(s), results.filter((r) => r.strategy === strategyName(s))));
  const smr = strategies.find((s) => s.strategy.startsWith("smr"));
  const comparisons = smr ? strategies.filter((s) => s !== smr).map((b) => compare(smr, b)) : [];
  return { suite: suite.name, startedAt, finishedAt: new Date().toISOString(), simulated: !!sim, seed: sim ? opts.simulate?.seed ?? 42 : undefined, strategies, comparisons, results, replay };
}

function summarize(strategy: string, rs: CaseResult[]): StrategySummary {
  const sum = (f: (r: CaseResult) => number) => rs.reduce((s, r) => s + f(r), 0);
  const usd = rs.every((r) => r.costUsd !== null) && rs.length ? sum((r) => r.costUsd ?? 0) : null;
  const passed = rs.filter((r) => r.passed).length;
  return {
    strategy,
    cases: rs.length,
    passed,
    successRate: rs.length ? Math.round((passed / rs.length) * 1000) / 1000 : 0,
    attempts: sum((r) => r.attempts),
    retries: sum((r) => Math.max(0, r.attempts - 1)),
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    costUsd: usd === null ? null : Math.round(usd * 1e6) / 1e6,
    costUnits: Math.round(sum((r) => r.costUnits) * 1e6) / 1e6,
    avgDurationMs: rs.length ? Math.round(sum((r) => r.durationMs) / rs.length) : 0,
  };
}

function compare(smr: StrategySummary, b: StrategySummary): Comparison {
  const cost = (s: StrategySummary) => (smr.costUsd !== null && b.costUsd !== null ? s.costUsd! : s.costUnits);
  const pct = (a: number, base: number) => (base ? Math.round(((a - base) / base) * 1000) / 10 : 0);
  const successDeltaPts = Math.round((smr.successRate - b.successRate) * 1000) / 10;
  const costDeltaPct = pct(cost(smr), cost(b));
  const tokenDeltaPct = pct(smr.inputTokens + smr.outputTokens, b.inputTokens + b.outputTokens);
  const okSuccess = successDeltaPts >= 0;
  const okCost = costDeltaPct <= 0;
  const verdict = okSuccess && (okCost || successDeltaPts > 0) ? "pass" : "fail";
  const why = !okSuccess
    ? `SMR succeeded on ${Math.abs(successDeltaPts)} pts fewer tasks — savings don't count if tasks fail`
    : okCost
      ? `same-or-better success at ${Math.abs(costDeltaPct)}% ${costDeltaPct <= 0 ? "lower" : "higher"} cost`
      : `higher success (+${successDeltaPts} pts) for ${costDeltaPct}% more cost`;
  return { baseline: b.strategy, successDeltaPts, costDeltaPct, tokenDeltaPct, verdict, why };
}

/** Feed benchmark results into the main execution log so the Learning Engine can use them. */
export function importBenchmark(store: ExecutionStore, report: BenchmarkReport, registry = new ModelRegistry()): number {
  let n = 0;
  for (const r of report.replay) {
    if (!r.attempts.length) continue;
    const first = registry.get(r.attempts[0]!.modelId) ?? registry.all()[0]!;
    const decision = {
      taskId: r.classification.taskId, selectedModel: first.id, host: "generic" as const, hostModel: first.id, mode: "smart" as const,
      routingReason: `benchmark ${report.suite} (${r.strategy}${report.simulated ? ", simulated" : ""})`,
      successProbability: 0, estimatedCost: { usd: null, relativeUnits: 0, inputTokens: 0, outputTokens: 0 },
      fallbackModels: [], verificationRequired: false, verificationLevels: [], candidates: [],
    };
    const t = store.createTask(`[bench:${report.suite}/${r.caseId}] ${r.task}`, r.classification, decision);
    for (const a of r.attempts) {
      store.addAttempt({ taskId: t.id, modelId: a.modelId, passed: a.passed, failureReason: a.failureReason, inputTokens: a.inputTokens, outputTokens: a.outputTokens, costUsd: a.costUsd, costUnits: a.costUnits, durationMs: a.durationMs });
      n++;
    }
    store.setStatus(t.id, r.attempts.some((a) => a.passed) ? "completed" : "failed");
  }
  return n;
}
