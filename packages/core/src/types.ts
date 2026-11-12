import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Task classification                                                 */
/* ------------------------------------------------------------------ */

export const TASK_CATEGORIES = [
  "ideation",
  "planning",
  "research",
  "development",
  "debugging",
  "optimization",
  "testing",
  "review",
  "documentation",
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

/** 1 = Simple, 2 = Moderate, 3 = Complex, 4 = Critical */
export type Complexity = 1 | 2 | 3 | 4;
export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface TaskClassification {
  taskId: string;
  category: TaskCategory;
  subcategory?: string;
  complexity: Complexity;
  riskLevel: RiskLevel;
  reasoningRequired: boolean;
  codingRequired: boolean;
  visionRequired: boolean;
  estimatedContextTokens: number;
  estimatedOutputTokens: number;
  successCriteria: string[];
  /** Human-readable reasons — why the classifier decided this. */
  signals: string[];
  /** 0–1. Low confidence => host may ask a cheap LLM to re-classify. */
  confidence: number;
}

/* ------------------------------------------------------------------ */
/* Model registry                                                      */
/* ------------------------------------------------------------------ */

export const ScoreSchema = z.number().min(0).max(100);

export const ModelSpecSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  displayName: z.string().min(1),
  tier: z.enum(["budget", "standard", "premium", "frontier"]),
  /** How each host refers to this model (Claude Code alias, OpenCode provider/model id ...). */
  hostAliases: z.record(z.string(), z.string()).default({}),
  scores: z.object({
    coding: ScoreSchema,
    reasoning: ScoreSchema,
    debugging: ScoreSchema,
    creative: ScoreSchema,
    instructionFollowing: ScoreSchema,
    speed: ScoreSchema,
  }),
  /** Where the scores came from. "initial-estimate" must be replaced by benchmarks over time. */
  scoreSource: z.enum(["initial-estimate", "provider", "benchmark", "observed"]).default("initial-estimate"),
  contextWindow: z.number().int().positive().optional(),
  /** USD per 1M tokens. Leave null until you've verified current provider pricing. */
  pricing: z
    .object({
      inputPerMTok: z.number().nonnegative(),
      outputPerMTok: z.number().nonnegative(),
      cachedInputPerMTok: z.number().nonnegative().optional(),
    })
    .nullable()
    .default(null),
  /** Relative cost index (cheapest ≈ 1). Used when real pricing is unknown. */
  relativeCost: z.number().positive(),
  capabilities: z.object({
    toolCalling: z.boolean(),
    vision: z.boolean(),
  }),
  available: z.boolean().default(true),
  notes: z.string().optional(),
});
export type ModelSpec = z.infer<typeof ModelSpecSchema>;

export const RegistrySchema = z.object({
  version: z.number().int().default(1),
  models: z.array(ModelSpecSchema).min(1),
});
export type Registry = z.infer<typeof RegistrySchema>;

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

export type RoutingMode = "smart" | "economy" | "quality";
export type ApprovalMode = "auto" | "confirm" | "recommend";
export type HostId = "claude-code" | "opencode" | "codex" | "generic";

export interface RouterOptions {
  mode?: RoutingMode;
  host?: HostId;
  /** Minimum success probability for any task (0–1). */
  minSuccessProbability?: number;
  /** Minimum success probability for critical tasks (0–1). Never relaxed by cost. */
  criticalSuccessProbability?: number;
  /** Optional hard ceiling per task in USD (only enforced when pricing is known). */
  costCeilingUsd?: number;
  /** Model ids to skip (e.g. already failed). */
  exclude?: string[];
  /** Learning Engine: observed results blended into success probability and token estimates. */
  history?: import("./learning.js").PerformanceHistory;
  /** Pseudo-observations the registry prior is worth (default 8). */
  priorStrength?: number;
}

export interface ScoreBreakdown {
  quality: number;
  suitability: number;
  reliability: number;
  costEfficiency: number;
  latency: number;
  total: number;
}

export interface CandidateScore {
  modelId: string;
  successProbability: number;
  estimatedCost: CostEstimate;
  breakdown: ScoreBreakdown;
  rejectedReason?: string;
  /** Present when the Learning Engine had data for this model on this kind of task. */
  observed?: { attempts: number; passRate: number; priorP: number; scope: "exact" | "pooled" };
}

export interface RoutingDecision {
  taskId: string;
  selectedModel: string;
  /** Host this decision was made for — later steps of the task reuse it. */
  host: HostId;
  /** What the host should put in its model field (e.g. "haiku" for Claude Code). */
  hostModel: string;
  mode: RoutingMode;
  routingReason: string;
  successProbability: number;
  estimatedCost: CostEstimate;
  fallbackModels: string[];
  verificationRequired: boolean;
  verificationLevels: VerificationLevel[];
  candidates: CandidateScore[];
}

export type VerificationLevel = "static" | "functional" | "semantic";

export interface CostEstimate {
  /** null when the registry has no verified pricing for this model. */
  usd: number | null;
  /** relativeCost × (token volume / 1M) — always available, good for comparison. */
  relativeUnits: number;
  inputTokens: number;
  outputTokens: number;
}

/* ------------------------------------------------------------------ */
/* Escalation                                                          */
/* ------------------------------------------------------------------ */

export interface AttemptRecord {
  modelId: string;
  passed: boolean;
  failureReason?: string;
  costUsd?: number;
}

export interface EscalationPolicy {
  maxRetriesPerModel: number;
  maxEscalations: number;
  costCeilingUsd?: number;
}

export type EscalationAction = "complete" | "retry" | "escalate" | "stop";

export interface EscalationDecision {
  action: EscalationAction;
  modelId?: string;
  hostModel?: string;
  reason: string;
}
