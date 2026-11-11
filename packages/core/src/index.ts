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
export {
  ProviderRegistry, ProviderError, anthropicProvider, openAICompatibleProvider, googleProvider,
  type ProviderAdapter, type CompletionRequest, type CompletionResult, type FetchLike,
} from "./providers.js";
export { providerBackend } from "./llm-classifier.js";
export { executeTask, defaultVerifier, type Verifier, type ExecuteResult, type ExecuteEvent } from "./executor.js";
export { loadConfig, registryFor, policyFor, routerOptsFor, storeDirFor, historyFor, type SmrConfig } from "./config.js";
export { buildHistory, blendProbability, DEFAULT_LEARNING, type PerformanceHistory, type Observation, type LearningOptions, type LearningRow } from "./learning.js";
export type { PerformanceRow } from "./store.js";
export { usageFromTranscript, readTranscript, SMR_AGENT_MODELS, type SubagentStopInput, type TranscriptUsage } from "./hooks.js";

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
export { packContext, collectFiles, compressText, estimateTokens, keywords, suggestMaxTokens, type ContextFile, type PackResult, type PackedFile } from "./optimizer.js";
export { runBenchmark, verifierFor, extractCode, simulatedProviders, importBenchmark, parseStrategy, strategyName, type BenchmarkSuite, type BenchmarkCase, type BenchmarkReport, type CaseResult, type StrategySummary, type Comparison, type Strategy, type VerifySpec } from "./benchmark.js";
export { learningReport, estimateSavings, syntheticTask, type SavingsEstimate } from "./insights.js";
export { buildDashboardData, renderDashboard, type DashboardData } from "./dashboard.js";
