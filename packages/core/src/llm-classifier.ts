import { createHash } from "node:crypto";
import { z } from "zod";
import { classifyTask } from "./classifier.js";
import { anthropicProvider, ProviderRegistry } from "./providers.js";
import { TASK_CATEGORIES, type Complexity, type RiskLevel, type TaskClassification } from "./types.js";

/**
 * Hybrid classification (blueprint §3A):
 *   rule-based first (free) → only when confidence is low, ask a CHEAP model → cache the answer.
 *
 * Safety rule: the LLM can refine category/complexity, but it can never LOWER the risk the
 * rules detected (security / payments / production keywords stay critical).
 */

export interface LlmBackend {
  readonly name: string;
  complete(prompt: string): Promise<string>;
}

export interface ClassificationCache {
  cacheGet(key: string): string | undefined;
  cacheSet(key: string, value: string): void;
}

const LlmAnswerSchema = z.object({
  category: z.enum(TASK_CATEGORIES),
  complexity: z.number().int().min(1).max(4),
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  visionRequired: z.boolean().optional(),
});

const RISK_ORDER: RiskLevel[] = ["low", "medium", "high", "critical"];

export function buildClassifierPrompt(task: string): string {
  return [
    "Classify this software task for model routing. Reply with ONLY a JSON object, no prose:",
    `{"category": one of ${JSON.stringify(TASK_CATEGORIES)},`,
    ` "complexity": 1 (simple, minutes) | 2 (moderate) | 3 (complex, multi-file/system) | 4 (critical),`,
    ` "riskLevel": "low" | "medium" | "high" | "critical"  (auth/payments/prod data/security = high or critical),`,
    ` "visionRequired": true if it needs looking at an image/screenshot}`,
    "",
    "The task may be in English, Hindi or Hinglish.",
    `Task: """${task.slice(0, 2000)}"""`,
  ].join("\n");
}

export function parseLlmAnswer(raw: string): z.infer<typeof LlmAnswerSchema> | undefined {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const r = LlmAnswerSchema.safeParse(JSON.parse(m[0]));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

export async function classifyWithFallback(
  task: string,
  opts: { backend?: LlmBackend; threshold?: number; cache?: ClassificationCache } = {},
): Promise<TaskClassification> {
  const base = classifyTask(task);
  const threshold = opts.threshold ?? 0.6;
  if (!opts.backend || base.confidence >= threshold) return base;

  const key = "cls:" + createHash("sha256").update(task.trim().toLowerCase()).digest("hex").slice(0, 24);
  let answer = opts.cache?.cacheGet(key) ? parseLlmAnswer(opts.cache.cacheGet(key)!) : undefined;
  let source = "cache";
  if (!answer) {
    try {
      const raw = await opts.backend.complete(buildClassifierPrompt(task));
      answer = parseLlmAnswer(raw);
      source = opts.backend.name;
      if (answer) opts.cache?.cacheSet(key, JSON.stringify(answer));
    } catch (e) {
      return { ...base, signals: [...base.signals, `LLM classifier failed (${(e as Error).message}) — kept rule-based result`] };
    }
  }
  if (!answer) return { ...base, signals: [...base.signals, "LLM classifier gave an unusable answer — kept rule-based result"] };

  // Never lower detected risk.
  const risk = RISK_ORDER[Math.max(RISK_ORDER.indexOf(base.riskLevel), RISK_ORDER.indexOf(answer.riskLevel))]!;
  let complexity = answer.complexity as Complexity;
  if (risk === "critical") complexity = 4;
  else if (risk === "high" && complexity < 2) complexity = 2;

  const refined = classifyTask(task); // fresh copy for derived fields
  return {
    ...refined,
    category: answer.category,
    subcategory: answer.category === base.category ? base.subcategory : undefined,
    complexity,
    riskLevel: risk,
    visionRequired: base.visionRequired || !!answer.visionRequired,
    reasoningRequired: ["planning", "debugging", "review", "optimization"].includes(answer.category) || complexity >= 3,
    codingRequired: ["development", "debugging", "optimization", "testing"].includes(answer.category),
    estimatedContextTokens: [0, 4_000, 12_000, 40_000, 80_000][complexity]!,
    estimatedOutputTokens: [0, 1_000, 4_000, 12_000, 20_000][complexity]!,
    confidence: 0.8,
    signals: [...base.signals, `low rule confidence (${base.confidence}) → refined by ${source}`],
  };
}

/**
 * Classifier backend on top of ANY provider adapter. `modelId` is a registry id such as
 * "anthropic/claude-haiku-5-5", "openrouter/vendor/model" or "ollama/qwen3".
 */
export function providerBackend(providers: ProviderRegistry, modelId: string, timeoutMs = 20_000): LlmBackend {
  providers.resolve(modelId); // fail fast on unknown provider
  return {
    name: modelId,
    async complete(prompt: string): Promise<string> {
      return (await providers.complete(modelId, { prompt, maxTokens: 150, timeoutMs })).text;
    },
  };
}

/** Anthropic backend (key from ANTHROPIC_API_KEY — never logged or put in a prompt). */
export function anthropicBackend(opts: { apiKey?: string; model?: string; baseUrl?: string; timeoutMs?: number } = {}): LlmBackend {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (needed for LLM classification).");
  const providers = new ProviderRegistry([anthropicProvider({ apiKey, baseUrl: opts.baseUrl })]);
  return providerBackend(providers, `anthropic/${opts.model ?? "claude-haiku-5-5"}`, opts.timeoutMs);
}
