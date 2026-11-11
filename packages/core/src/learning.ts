import type { PerformanceRow } from "./store.js";
import type { TaskCategory } from "./types.js";

/**
 * Learning Engine — adaptive model ranking from real results.
 *
 * Statistical first (blueprint §3H): Bayesian blend of the registry's prior success
 * probability with what actually happened.
 *
 *     p = (p_prior · k + passes) / (k + attempts)
 *
 * k (priorStrength) = how many observations the prior is "worth". With little data the
 * prior dominates; with lots of data reality wins. Nothing is ever fully trusted from a
 * handful of runs, and critical-task floors still apply on top.
 *
 * Lookup order: exact (model, category, complexity) → pooled (model, category) at a discount.
 */

export interface Observation {
  attempts: number;
  passes: number;
  passRate: number;
  avgInputTokens?: number;
  avgOutputTokens?: number;
  /** "exact" = same category+complexity, "pooled" = same category, other complexities. */
  scope: "exact" | "pooled";
}

export interface PerformanceHistory {
  readonly size: number;
  lookup(modelId: string, category: TaskCategory, complexity: number): Observation | undefined;
}

export interface LearningOptions {
  /** Pseudo-observations the prior is worth. Default 8. */
  priorStrength?: number;
  /** Below this many observations, observed token averages are not trusted. Default 3. */
  minTokenSamples?: number;
  /** Pooled (other-complexity) evidence counts this much. Default 0.5. */
  pooledWeight?: number;
}

export const DEFAULT_LEARNING: Required<LearningOptions> = { priorStrength: 8, minTokenSamples: 3, pooledWeight: 0.5 };

export function buildHistory(rows: PerformanceRow[], opts: LearningOptions = {}): PerformanceHistory {
  const o = { ...DEFAULT_LEARNING, ...opts };
  const exact = new Map<string, PerformanceRow>();
  const pooled = new Map<string, PerformanceRow[]>();
  for (const r of rows) {
    exact.set(`${r.modelId}|${r.category}|${r.complexity}`, r);
    const k = `${r.modelId}|${r.category}`;
    pooled.set(k, [...(pooled.get(k) ?? []), r]);
  }
  const toObs = (attempts: number, passes: number, tokenSamples: number, inTok: number, outTok: number, scope: Observation["scope"]): Observation => ({
    attempts,
    passes,
    passRate: attempts ? passes / attempts : 0,
    scope,
    ...(tokenSamples >= o.minTokenSamples ? { avgInputTokens: Math.round(inTok / tokenSamples), avgOutputTokens: Math.round(outTok / tokenSamples) } : {}),
  });
  return {
    size: rows.reduce((s, r) => s + r.attempts, 0),
    lookup(modelId, category, complexity) {
      const e = exact.get(`${modelId}|${category}|${complexity}`);
      if (e && e.attempts > 0) return toObs(e.attempts, e.passes, e.tokenSamples, e.inputTokens, e.outputTokens, "exact");
      const others = (pooled.get(`${modelId}|${category}`) ?? []).filter((r) => r.complexity !== complexity);
      if (!others.length) return undefined;
      const sum = (f: (r: PerformanceRow) => number) => others.reduce((s, r) => s + f(r), 0);
      // Discounted: other complexities are weaker evidence. Tokens are NOT pooled (they scale with complexity).
      const w = o.pooledWeight;
      return toObs(sum((r) => r.attempts) * w, sum((r) => r.passes) * w, 0, 0, 0, "pooled");
    },
  };
}

export function blendProbability(prior: number, obs: Observation | undefined, priorStrength = DEFAULT_LEARNING.priorStrength): number {
  if (!obs || obs.attempts <= 0) return prior;
  return (prior * priorStrength + obs.passes) / (priorStrength + obs.attempts);
}

export interface LearningRow {
  modelId: string;
  category: TaskCategory;
  complexity: number;
  attempts: number;
  observedPassRate: number;
  priorP: number;
  blendedP: number;
  avgInputTokens?: number;
  avgOutputTokens?: number;
}
