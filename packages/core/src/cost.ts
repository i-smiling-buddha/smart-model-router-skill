import type { CostEstimate, ModelSpec } from "./types.js";

/**
 * Estimate the cost of ONE attempt on a model.
 * USD only when verified pricing exists; relativeUnits always.
 */
export function estimateCost(
  model: ModelSpec,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): CostEstimate {
  const uncachedInput = Math.max(0, inputTokens - cachedInputTokens);
  let usd: number | null = null;
  if (model.pricing) {
    const p = model.pricing;
    const cachedRate = p.cachedInputPerMTok ?? p.inputPerMTok;
    usd =
      (uncachedInput * p.inputPerMTok + cachedInputTokens * cachedRate + outputTokens * p.outputPerMTok) / 1_000_000;
    usd = round(usd, 6);
  }
  // Output tokens are typically several times pricier than input; weight them 4×.
  const relativeUnits = round((model.relativeCost * (uncachedInput + cachedInputTokens * 0.1 + outputTokens * 4)) / 1_000_000, 6);
  return { usd, relativeUnits, inputTokens, outputTokens };
}

/**
 * The number that actually matters: expected cost per SUCCESSFUL task.
 * A cheap model that fails 5 times is not cheap.  cost / p(success)
 */
export function expectedCostPerSuccess(cost: CostEstimate, successProbability: number): number {
  const p = Math.max(successProbability, 0.01);
  return (cost.usd ?? cost.relativeUnits) / p;
}

export function formatCost(c: CostEstimate): string {
  return c.usd !== null ? `$${c.usd.toFixed(4)}` : `${c.relativeUnits.toFixed(4)} cost-units (pricing not set)`;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Running per-task usage ledger — feeds the final report / dashboard later. */
export class CostLedger {
  private entries: { modelId: string; inputTokens: number; outputTokens: number; usd: number | null }[] = [];

  record(modelId: string, estimate: CostEstimate): void {
    this.entries.push({ modelId, inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens, usd: estimate.usd });
  }

  summary() {
    const byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; usd: number | null }> = {};
    for (const e of this.entries) {
      const row = (byModel[e.modelId] ??= { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 });
      row.calls++;
      row.inputTokens += e.inputTokens;
      row.outputTokens += e.outputTokens;
      row.usd = row.usd === null || e.usd === null ? null : row.usd + e.usd;
    }
    const totals = Object.values(byModel);
    const totalUsd = totals.some((r) => r.usd === null) ? null : totals.reduce((s, r) => s + (r.usd ?? 0), 0);
    return { byModel, totalUsd };
  }
}
