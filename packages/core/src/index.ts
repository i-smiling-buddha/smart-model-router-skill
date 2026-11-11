export * from "./types.js";
export { classifyTask, verificationLevelsFor } from "./classifier.js";
export { ModelRegistry, DEFAULT_REGISTRY, tierRank } from "./registry.js";
export { Router, MODE_WEIGHTS, CATEGORY_CAPABILITY_WEIGHTS, suitability, successProbability, taskDemand } from "./router.js";
export { estimateCost, expectedCostPerSuccess, formatCost, CostLedger } from "./cost.js";
export { decideNext, DEFAULT_POLICY } from "./escalation.js";
export { buildHandoff, redactSecrets, isSensitiveFile, type TaskHandoff } from "./handoff.js";
export { evaluate, detectChecks, shellRunner, type CheckCommand, type CheckResult, type EvaluationResult, type CommandRunner } from "./evaluator.js";
export { openStore, JsonStore, SqliteStore, newTaskId, type ExecutionStore, type TaskRecord, type AttemptRow, type ModelStats, type TaskStatus } from "./store.js";
export { classifyWithFallback, anthropicBackend, buildClassifierPrompt, parseLlmAnswer, type LlmBackend, type ClassificationCache } from "./llm-classifier.js";
export { TaskSession } from "./session.js";

import { classifyTask } from "./classifier.js";
import { ModelRegistry } from "./registry.js";
import { Router } from "./router.js";
import type { RouterOptions } from "./types.js";

/** One-call convenience: classify + route. */
export function routeTask(task: string, opts: RouterOptions & { registry?: ModelRegistry } = {}) {
  const classification = classifyTask(task);
  const decision = new Router(opts.registry ?? new ModelRegistry()).route(classification, opts);
  return { classification, decision };
}
