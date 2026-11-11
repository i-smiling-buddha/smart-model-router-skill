import { estimateCost, expectedCostPerSuccess } from "./cost.js";
import { verificationLevelsFor } from "./classifier.js";
import { ModelRegistry } from "./registry.js";
import type {
  CandidateScore,
  ModelSpec,
  RouterOptions,
  RoutingDecision,
  RoutingMode,
  TaskCategory,
  TaskClassification,
} from "./types.js";

/**
 * Intelligent Router
 *
 *   Score(m,t) = wQ·Q + wS·S + wR·R + wC·C + wL·L        (smart: .35 .25 .20 .10 .10)
 *
 *   Q  Quality       = does the model's category-weighted capability clear what THIS task
 *                      demands? (capped — extra power beyond the need adds nothing)
 *   S  Suitability   = right-sized fit: Q minus a mild penalty for heavy overkill
 *                      (this is what lets cheap models win easy tasks)
 *   R  Reliability   = p(success) × 100
 *   C  Cost eff.     = cheapest expected-cost-per-SUCCESS / this model's   × 100
 *   L  Latency eff.  = speed score
 *
 * Hard rules: availability, vision/tool support, context window, cost ceiling,
 * and a success-probability floor that is stricter for critical tasks and never traded for cost.
 */

export const MODE_WEIGHTS: Record<RoutingMode, { Q: number; S: number; R: number; C: number; L: number }> = {
  smart: { Q: 0.35, S: 0.25, R: 0.2, C: 0.1, L: 0.1 },
  economy: { Q: 0.25, S: 0.15, R: 0.2, C: 0.3, L: 0.1 },
  quality: { Q: 0.4, S: 0.25, R: 0.25, C: 0.05, L: 0.05 },
};

type Cap = keyof Omit<ModelSpec["scores"], "speed">;
export const CATEGORY_CAPABILITY_WEIGHTS: Record<TaskCategory, Partial<Record<Cap, number>>> = {
  ideation: { creative: 0.6, reasoning: 0.4 },
  planning: { reasoning: 0.7, coding: 0.2, creative: 0.1 },
  research: { instructionFollowing: 0.4, coding: 0.3, reasoning: 0.3 },
  development: { coding: 0.6, reasoning: 0.25, debugging: 0.15 },
  debugging: { debugging: 0.5, reasoning: 0.3, coding: 0.2 },
  optimization: { coding: 0.5, reasoning: 0.35, debugging: 0.15 },
  testing: { coding: 0.6, instructionFollowing: 0.3, debugging: 0.1 },
  review: { reasoning: 0.45, coding: 0.35, debugging: 0.2 },
  documentation: { instructionFollowing: 0.5, creative: 0.3, coding: 0.2 },
};

/** Capability a task "demands", by complexity level. */
const DEMAND_BY_COMPLEXITY = { 1: 50, 2: 65, 3: 78, 4: 84 } as const;
/** Some categories are inherently easier/harder at the same complexity. */
const CATEGORY_DEMAND_OFFSET: Partial<Record<TaskCategory, number>> = {
  research: -10,
  documentation: -5,
  testing: -5,
  planning: 5,
  debugging: 5,
};
const QUALITY_HEADROOM = 10;
const OVERKILL_MARGIN = 15;
const SIGMOID_SCALE = 5;

export function taskDemand(t: TaskClassification): number {
  let d = DEMAND_BY_COMPLEXITY[t.complexity] + (CATEGORY_DEMAND_OFFSET[t.category] ?? 0);
  if (t.riskLevel === "high") d += 3;
  if (t.subcategory === "security-audit") d += 2;
  return d;
}

export function suitability(m: ModelSpec, t: TaskClassification): number {
  const weights = CATEGORY_CAPABILITY_WEIGHTS[t.category];
  let s = 0;
  let total = 0;
  for (const [cap, wgt] of Object.entries(weights) as [Cap, number][]) {
    s += m.scores[cap] * wgt;
    total += wgt;
  }
  return s / total;
}

export function successProbability(m: ModelSpec, t: TaskClassification): number {
  const x = (suitability(m, t) - taskDemand(t)) / SIGMOID_SCALE;
  return 1 / (1 + Math.exp(-x));
}

export class Router {
  constructor(private readonly registry: ModelRegistry = new ModelRegistry()) {}

  route(task: TaskClassification, opts: RouterOptions = {}): RoutingDecision {
    const mode = opts.mode ?? "smart";
    const host = opts.host ?? "generic";
    const weights = MODE_WEIGHTS[mode];
    const minP = opts.minSuccessProbability ?? (mode === "economy" ? 0.55 : 0.6);
    const criticalP = opts.criticalSuccessProbability ?? 0.8;
    const floor = task.riskLevel === "critical" || task.complexity === 4 ? Math.max(minP, criticalP) : minP;
    const exclude = new Set(opts.exclude ?? []);
    const demand = taskDemand(task);

    const candidates: CandidateScore[] = [];
    for (const m of this.registry.all()) {
      const p = successProbability(m, task);
      const cost = estimateCost(m, task.estimatedContextTokens, task.estimatedOutputTokens);
      const base: CandidateScore = {
        modelId: m.id,
        successProbability: round(p, 3),
        estimatedCost: cost,
        breakdown: { quality: 0, suitability: 0, reliability: 0, costEfficiency: 0, latency: 0, total: 0 },
      };
      const reject = hardReject(m, task, p, floor, cost.usd, opts.costCeilingUsd, exclude);
      if (reject) base.rejectedReason = reject;
      candidates.push(base);
    }

    let eligible = candidates.filter((c) => !c.rejectedReason);
    let floorRelaxed = false;
    if (eligible.length === 0) {
      // Nobody clears the reliability floor: fall back to the most capable usable model (never cheapest).
      const usable = candidates.filter((c) => !/unavailable|vision|tool|context|excluded/.test(c.rejectedReason ?? ""));
      if (usable.length === 0) throw new Error("No available model can handle this task. Check the registry / exclusions.");
      const strongest = usable.sort((a, b) => b.successProbability - a.successProbability)[0]!;
      strongest.rejectedReason = undefined;
      eligible = [strongest];
      floorRelaxed = true;
    }

    const minCostPerSuccess = Math.min(...eligible.map((c) => expectedCostPerSuccess(c.estimatedCost, c.successProbability)));
    for (const c of eligible) {
      const m = this.registry.require(c.modelId);
      const raw = suitability(m, task);
      const target = demand + QUALITY_HEADROOM;
      // Q: is the model good enough? (capped — power beyond the need adds nothing)
      const Q = clamp(100 - Math.max(0, target - raw) * 2.5);
      // S: right-sized fit — under-powered is bad, heavy overkill is mildly bad too.
      const S = clamp(Q - Math.max(0, raw - (target + OVERKILL_MARGIN)));
      const R = c.successProbability * 100;
      const C = (minCostPerSuccess / expectedCostPerSuccess(c.estimatedCost, c.successProbability)) * 100;
      const L = m.scores.speed;
      const total = weights.Q * Q + weights.S * S + weights.R * R + weights.C * C + weights.L * L;
      c.breakdown = { quality: r1(Q), suitability: r1(S), reliability: r1(R), costEfficiency: r1(C), latency: r1(L), total: r1(total) };
    }

    eligible.sort((a, b) => b.breakdown.total - a.breakdown.total);
    const winner = eligible[0]!;
    const winnerModel = this.registry.require(winner.modelId);

    // Fallbacks = stronger eligible-or-floor-failing models, ordered by capability (escalation path).
    const fallbackModels = this.registry
      .available()
      .filter((m) => m.id !== winner.modelId && !exclude.has(m.id) && successProbability(m, task) > winner.successProbability)
      .sort((a, b) => successProbability(b, task) - successProbability(a, task))
      .reverse()
      .map((m) => m.id);

    const verificationLevels = verificationLevelsFor(task);
    return {
      taskId: task.taskId,
      host,
      selectedModel: winner.modelId,
      hostModel: this.registry.hostModel(winnerModel, host),
      mode,
      routingReason: explain(winnerModel, task, winner, mode, floorRelaxed),
      successProbability: winner.successProbability,
      estimatedCost: winner.estimatedCost,
      fallbackModels,
      verificationRequired: verificationLevels.length > 0,
      verificationLevels,
      candidates: [...eligible, ...candidates.filter((c) => c.rejectedReason)],
    };
  }
}

function hardReject(
  m: ModelSpec,
  t: TaskClassification,
  p: number,
  floor: number,
  usd: number | null,
  ceiling: number | undefined,
  exclude: Set<string>,
): string | undefined {
  if (exclude.has(m.id)) return "excluded (already failed / user excluded)";
  if (!m.available) return "unavailable";
  if (t.visionRequired && !m.capabilities.vision) return "no vision support";
  if (t.codingRequired && !m.capabilities.toolCalling) return "no tool calling (needed for code edits)";
  if (m.contextWindow && t.estimatedContextTokens > m.contextWindow * 0.8) return "context window too small";
  if (ceiling !== undefined && usd !== null && usd > ceiling) return `over cost ceiling ($${ceiling})`;
  if (p < floor) return `success probability ${(p * 100).toFixed(0)}% below floor ${(floor * 100).toFixed(0)}%`;
  return undefined;
}

function explain(m: ModelSpec, t: TaskClassification, c: CandidateScore, mode: RoutingMode, relaxed: boolean): string {
  const lvl = ["", "simple", "moderate", "complex", "critical"][t.complexity];
  const why =
    m.tier === "budget"
      ? "cheapest model that reliably clears this task"
      : c.breakdown.costEfficiency >= 99
        ? "lowest expected cost per successful task"
        : "cheaper models are too likely to fail and need retries";
  const base = `${lvl} ${t.category} → ${m.displayName}: ${why} (p≈${Math.round(c.successProbability * 100)}%, mode=${mode})`;
  return relaxed ? `${base}. WARNING: no model cleared the reliability floor — strongest available chosen; consider human review.` : base;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));
const r1 = (n: number) => Math.round(n * 10) / 10;
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
