import { estimateCost } from "./cost.js";
import { blendProbability, buildHistory, DEFAULT_LEARNING, type LearningOptions, type LearningRow } from "./learning.js";
import { ModelRegistry, tierRank } from "./registry.js";
import { successProbability } from "./router.js";
import type { ExecutionStore } from "./store.js";
import type { Complexity, ModelSpec, TaskCategory, TaskClassification } from "./types.js";

/** A neutral task of a given category/complexity — for comparing priors with observations. */
export function syntheticTask(category: TaskCategory, complexity: number): TaskClassification {
  const c = Math.min(4, Math.max(1, Math.round(complexity))) as Complexity;
  return {
    taskId: `synthetic_${category}_${c}`, category, complexity: c, riskLevel: c === 4 ? "critical" : c >= 2 ? "medium" : "low",
    reasoningRequired: c >= 3, codingRequired: ["development", "debugging", "optimization", "testing"].includes(category),
    visionRequired: false, estimatedContextTokens: 0, estimatedOutputTokens: 0, successCriteria: [], signals: [], confidence: 1,
  };
}

/** Prior vs observed vs blended success, per model × category × complexity (what `smr learn` shows). */
export function learningReport(store: ExecutionStore, registry = new ModelRegistry(), opts: LearningOptions = {}): LearningRow[] {
  const rows = store.performanceStats();
  const history = buildHistory(rows, opts);
  const k = opts.priorStrength ?? DEFAULT_LEARNING.priorStrength;
  return rows
    .map((r) => {
      const m = registry.get(r.modelId);
      const prior = m ? successProbability(m, syntheticTask(r.category, r.complexity)) : 0.5;
      const obs = history.lookup(r.modelId, r.category, r.complexity);
      return {
        modelId: r.modelId, category: r.category, complexity: r.complexity, attempts: r.attempts,
        observedPassRate: Math.round((r.passes / r.attempts) * 1000) / 1000,
        priorP: Math.round(prior * 1000) / 1000,
        blendedP: Math.round(blendProbability(prior, obs, k) * 1000) / 1000,
        avgInputTokens: obs?.avgInputTokens, avgOutputTokens: obs?.avgOutputTokens,
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category) || a.complexity - b.complexity || a.modelId.localeCompare(b.modelId));
}

export interface SavingsEstimate {
  /** Model every attempt is compared against ("what if we always used the best model?"). */
  baselineModel: string;
  attemptsWithTokens: number;
  actual: number;
  baseline: number;
  unit: "usd" | "cost-units";
  savedPct: number;
}

/**
 * Savings vs always using the strongest model, on the same tokens.
 * Conservative: ignores that the best model might have needed fewer retries — it only counts
 * attempts that actually happened. Benchmarks give the full picture.
 */
export function estimateSavings(store: ExecutionStore, registry = new ModelRegistry()): SavingsEstimate {
  const best = registry.available().sort((a, b) => tierRank(b) - tierRank(a))[0] as ModelSpec;
  const attempts = store.listAttempts(100_000).filter((a) => a.inputTokens !== undefined || a.outputTokens !== undefined);
  const priced = attempts.every((a) => registry.get(a.modelId)?.pricing) && !!best.pricing;
  let actual = 0;
  let baseline = 0;
  for (const a of attempts) {
    const m = registry.get(a.modelId);
    if (!m) continue;
    const act = estimateCost(m, a.inputTokens ?? 0, a.outputTokens ?? 0);
    const base = estimateCost(best, a.inputTokens ?? 0, a.outputTokens ?? 0);
    actual += priced ? act.usd ?? 0 : act.relativeUnits;
    baseline += priced ? base.usd ?? 0 : base.relativeUnits;
  }
  return {
    baselineModel: best.id,
    attemptsWithTokens: attempts.length,
    actual: Math.round(actual * 1e6) / 1e6,
    baseline: Math.round(baseline * 1e6) / 1e6,
    unit: priced ? "usd" : "cost-units",
    savedPct: baseline ? Math.round((1 - actual / baseline) * 1000) / 10 : 0,
  };
}
