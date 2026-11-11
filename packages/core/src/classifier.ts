import { createHash } from "node:crypto";
import type { Complexity, RiskLevel, TaskCategory, TaskClassification, VerificationLevel } from "./types.js";

/**
 * Rule-based Task Classifier (Phase 1).
 *
 * Fast, free, deterministic. Understands English + Hindi (Devanagari) + Hinglish keywords.
 * When `confidence` is low, a host can optionally ask a cheap LLM to re-classify
 * (the hybrid approach from the blueprint) — that hook lands in Phase 2.
 */

interface CategoryRule {
  category: TaskCategory;
  subcategory?: string;
  patterns: RegExp[];
  weight: number;
}

/** Word-boundary regex that also works for Devanagari (letters + combining marks/matras). */
const w = (s: string) =>
  new RegExp(`(^|[^\\p{L}\\p{M}])(${s.replaceAll("\\w*", "[\\p{L}\\p{M}\\d_]*")})(?=$|[^\\p{L}\\p{M}])`, "iu");

const CATEGORY_RULES: CategoryRule[] = [
  { category: "ideation", subcategory: "brainstorming", weight: 1, patterns: [w("brainstorm\\w*|ideas?|suggest\\w*|naam|name ideas|विचार|आइडिया|सुझाव")] },
  { category: "planning", subcategory: "architecture", weight: 1.2, patterns: [w("architect\\w*|design the system|system design|roadmap|plan\\w*|blueprint|structure|tech stack|योजना|प्लान|आर्किटेक्चर")] },
  { category: "research", subcategory: "codebase-exploration", weight: 1, patterns: [w("explore|find where|where is|locate|search|list (all|the) files|understand (the|this) code(base)?|explain (this|the) code|how does .* work|कहाँ है|ढूंढ\\w*|खोज\\w*|समझा\\w*")] },
  { category: "development", subcategory: "implementation", weight: 1, patterns: [w("build|create|implement\\w*|add|make|develop|write (a|the)? ?(function|component|endpoint|api|class|script)|integrate|setup|set up|बना\\w*|जोड़\\w*|लिख\\w*")] },
  { category: "debugging", subcategory: "bug-fixing", weight: 1.3, patterns: [w("bug\\w*|error|exception|crash\\w*|not working|broken|fails?|failing|stack ?trace|debug\\w*|issue|गड़बड़|एरर|बग|नहीं चल\\w*"), w("fix\\w*|ठीक")] },
  { category: "optimization", subcategory: "refactoring", weight: 1.2, patterns: [w("refactor\\w*|optimi[sz]\\w*|performance|speed up|faster|slow|clean ?up|simplify|memory leak|reduce (bundle|size|latency)")] },
  { category: "testing", subcategory: "unit", weight: 1.2, patterns: [w("tests?|unit tests?|e2e|integration tests?|coverage|vitest|jest|pytest|spec|टेस्ट")] },
  { category: "review", subcategory: "code-review", weight: 1.3, patterns: [w("review|audit|check (my|the|this) code|security|vulnerab\\w*|pen ?test|owasp|रिव्यू|जाँच")] },
  { category: "documentation", subcategory: "docs", weight: 1.2, patterns: [w("typos?|readme|docs?|documentation|document (this|the)|comments?|jsdoc|docstring|changelog|api docs|डॉक्यूमेंट\\w*"), w("typos?|spelling|wording|text")] },
];

const SIMPLE_SIGNALS = w("typos?|rename|small|tiny|quick|minor|simple|one[- ]line|format\\w*|indent\\w*|lint|spelling|color|colour|padding|margin|css|छोटा|छोटी|आसान|बस");
const COMPLEX_SIGNALS = w("entire|whole|full|complete|end[- ]to[- ]end|from scratch|multi[- ]?file|across|architecture|system|migrat\\w*|concurren\\w*|race condition|distributed|scal\\w*|real[- ]?time|pure|पूरा|पूरी|पूरे");
const HIGH_RISK = w("auth\\w*|login|password|jwt|oauth|token|payment\\w*|billing|stripe|razorpay|upi|database migration|schema migration|prod(uction)?|deploy\\w*|delete|drop table|encrypt\\w*|permission\\w*");
const CRITICAL_RISK = w("security audit|vulnerab\\w*|pen ?test|production data|money|financial|payment gateway|data loss|secrets?|api keys?|compliance|gdpr");
const VISION = w("screenshot|image|mockup|figma|ui from (this|the) (image|design)|look at (this|the) (picture|screen)|फोटो|स्क्रीनशॉट");

const BASE_TOKENS: Record<Complexity, { ctx: number; out: number }> = {
  1: { ctx: 4_000, out: 1_000 },
  2: { ctx: 12_000, out: 4_000 },
  3: { ctx: 40_000, out: 12_000 },
  4: { ctx: 80_000, out: 20_000 },
};

const CODING_CATEGORIES = new Set<TaskCategory>(["development", "debugging", "optimization", "testing"]);
const REASONING_CATEGORIES = new Set<TaskCategory>(["planning", "debugging", "review", "optimization"]);

export function classifyTask(task: string, opts: { taskId?: string } = {}): TaskClassification {
  const text = task.trim();
  if (!text) throw new Error("Task text is empty.");
  const signals: string[] = [];

  // 1. Category — highest weighted match count wins.
  const scored = CATEGORY_RULES.map((r) => ({
    rule: r,
    score: r.patterns.reduce((s, p) => s + (p.test(text) ? 1 : 0), 0) * r.weight,
  })).sort((a, b) => b.score - a.score);
  let best = scored[0]!;
  const runnerUp = scored[1]!;
  if (best.score === 0) {
    best = { rule: CATEGORY_RULES.find((r) => r.category === "development")!, score: 0 };
    signals.push("no category keyword matched → defaulted to development");
  } else {
    signals.push(`category keywords → ${best.rule.category}`);
  }
  const category = best.rule.category;

  // 2. Complexity.
  let complexity = 2;
  const simple = SIMPLE_SIGNALS.test(text);
  const complex = COMPLEX_SIGNALS.test(text);
  const words = text.split(/\s+/).length;
  if (simple && !complex) { complexity = 1; signals.push("simple-task wording"); }
  if (complex) { complexity = 3; signals.push("large-scope wording"); }
  if (words > 120) { complexity = Math.max(complexity, 3); signals.push("long, detailed request"); }
  if (category === "documentation" || category === "research") complexity = Math.min(complexity, 2);
  if (category === "planning" && complexity < 3 && complex) complexity = 3;

  // 3. Risk.
  let riskLevel: RiskLevel = "low";
  if (complexity >= 2) riskLevel = "medium";
  if (HIGH_RISK.test(text)) { riskLevel = "high"; signals.push("touches auth/payments/prod/data"); }
  if (CRITICAL_RISK.test(text)) { riskLevel = "critical"; signals.push("security/money/data-loss sensitive"); }
  if (riskLevel === "high" && complexity < 2) complexity = 2;
  if (riskLevel === "critical") complexity = 4;

  const c = complexity as Complexity;
  const visionRequired = VISION.test(text);
  if (visionRequired) signals.push("needs image understanding");

  // Confidence: clear winner + clear wording → high.
  const margin = best.score - runnerUp.score;
  const confidence = best.score === 0 ? 0.3 : Math.min(0.95, 0.55 + margin * 0.2 + (simple || complex ? 0.1 : 0));

  return {
    taskId: opts.taskId ?? "task_" + createHash("sha1").update(text).digest("hex").slice(0, 8),
    category,
    subcategory: category === "review" && /security|vulnerab|audit|owasp/i.test(text) ? "security-audit" : best.rule.subcategory,
    complexity: c,
    riskLevel,
    reasoningRequired: REASONING_CATEGORIES.has(category) || c >= 3,
    codingRequired: CODING_CATEGORIES.has(category),
    visionRequired,
    estimatedContextTokens: BASE_TOKENS[c].ctx,
    estimatedOutputTokens: BASE_TOKENS[c].out,
    successCriteria: successCriteriaFor(category, c),
    signals,
    confidence: Math.round(confidence * 100) / 100,
  };
}

function successCriteriaFor(category: TaskCategory, c: Complexity): string[] {
  switch (category) {
    case "development":
      return ["Implementation complete", "Builds without errors", ...(c >= 2 ? ["Tests passing", "Existing behavior preserved"] : [])];
    case "debugging":
      return ["Root cause identified", "Bug no longer reproduces", "No new failures in existing tests"];
    case "optimization":
      return ["Behavior unchanged (tests pass)", "Measurable improvement or simpler code"];
    case "testing":
      return ["Tests run", "Tests cover the requested behavior"];
    case "review":
      return ["Concrete findings with file/line", "Severity ranked"];
    case "documentation":
      return ["Accurate to the code", "Covers what was asked"];
    case "planning":
      return ["Clear components and responsibilities", "Trade-offs stated", "Actionable next steps"];
    case "research":
      return ["Relevant files/answers located"];
    case "ideation":
      return ["Multiple distinct options"];
  }
}

/** Which verification levels are worth running for this task (README ≠ full test suite). */
export function verificationLevelsFor(t: TaskClassification): VerificationLevel[] {
  if (t.category === "documentation" || t.category === "ideation" || t.category === "research") return ["semantic"];
  if (t.category === "planning" || t.category === "review") return ["semantic"];
  if (t.complexity === 1) return ["static"];
  return ["static", "functional", "semantic"];
}
