import { describe, expect, it } from "vitest";
import {
  blendProbability,
  buildDashboardData,
  buildHistory,
  classifyTask,
  estimateSavings,
  estimateTokens,
  extractCode,
  importBenchmark,
  JsonStore,
  learningReport,
  packContext,
  parseStrategy,
  ProviderRegistry,
  renderDashboard,
  Router,
  runBenchmark,
  suggestMaxTokens,
  TaskSession,
  verifierFor,
  type BenchmarkSuite,
  type ProviderAdapter,
} from "../src/index.js";

const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";

describe("Learning engine", () => {
  it("blends prior with observations, prior-weighted when data is thin", () => {
    expect(blendProbability(0.9, undefined)).toBe(0.9);
    expect(blendProbability(0.9, { attempts: 2, passes: 0, passRate: 0, scope: "exact" }, 8)).toBeCloseTo(0.72);
    expect(blendProbability(0.9, { attempts: 200, passes: 20, passRate: 0.1, scope: "exact" }, 8)).toBeLessThan(0.15);
  });

  it("uses exact rows first, then discounted pooled rows; token averages need enough samples", () => {
    const h = buildHistory([
      { modelId: HAIKU, category: "documentation", complexity: 2, attempts: 4, passes: 4, tokenSamples: 4, inputTokens: 4000, outputTokens: 2000 },
      { modelId: HAIKU, category: "documentation", complexity: 1, attempts: 10, passes: 5, tokenSamples: 1, inputTokens: 100, outputTokens: 50 },
    ]);
    expect(h.lookup(HAIKU, "documentation", 2)).toMatchObject({ scope: "exact", attempts: 4, avgInputTokens: 1000, avgOutputTokens: 500 });
    expect(h.lookup(HAIKU, "documentation", 3)).toMatchObject({ scope: "pooled", attempts: 7 });
    expect(h.lookup(HAIKU, "documentation", 1)?.avgInputTokens).toBeUndefined();
    expect(h.lookup(SONNET, "documentation", 2)).toBeUndefined();
  });

  it("the router adapts: a cheap model that keeps failing loses the task", () => {
    const store = new JsonStore();
    const s = new TaskSession(store);
    const text = "write README docs for the auth module";
    expect(new Router().route(classifyTask(text)).selectedModel).toBe(HAIKU);
    for (let i = 0; i < 6; i++) {
      const t = s.start(text, classifyTask(text));
      s.recordAttempt(t.id, { model: HAIKU, passed: false });
    }
    const history = buildHistory(store.performanceStats());
    const d = new Router().route(classifyTask(text), { history });
    expect(d.selectedModel).not.toBe(HAIKU);
    const haiku = d.candidates.find((c) => c.modelId === HAIKU)!;
    expect(haiku.observed?.attempts).toBe(6);
    expect(haiku.successProbability).toBeLessThan(haiku.observed!.priorP);
  });

  it("learning report shows prior vs observed vs blended", () => {
    const store = new JsonStore();
    const s = new TaskSession(store);
    const t = s.start("add a dark mode toggle", classifyTask("add a dark mode toggle"));
    s.recordAttempt(t.id, { model: "sonnet", passed: true, inputTokens: 100, outputTokens: 10 });
    const [row] = learningReport(store);
    expect(row).toMatchObject({ modelId: SONNET, category: "development", attempts: 1, observedPassRate: 1 });
    expect(row!.blendedP).toBeGreaterThanOrEqual(row!.priorP);
  });
});

describe("Token optimizer", () => {
  const files = [
    { path: "src/escalation.ts", content: "export function decideNext() {\n  // retry limit and escalation\n  return maxRetriesPerModel;\n}\n" },
    { path: "src/unrelated.ts", content: "export const colors = ['red', 'green'];\n".repeat(50) },
    { path: "src/copy-of-escalation.ts", content: "export function decideNext() {\n  // retry limit and escalation\n  return maxRetriesPerModel;\n}\n" },
    { path: ".env", content: "API_KEY=supersecretvalue123" },
    { path: "node_modules/x/index.js", content: "junk" },
    { path: "src/big.ts", content: Array.from({ length: 2000 }, (_, i) => (i === 1500 ? "function escalation() { return retry; }" : `const filler${i} = ${i};`)).join("\n") },
  ];

  it("ranks relevant files first and never ships secrets, dupes or generated files", () => {
    const r = packContext("fix the escalation retry limit", files, 50_000);
    expect(r.files[0]!.path).toBe("src/escalation.ts");
    const reasons = Object.fromEntries(r.dropped.map((d) => [d.path, d.reason]));
    expect(reasons[".env"]).toMatch(/sensitive/);
    expect(reasons["src/copy-of-escalation.ts"]).toMatch(/duplicate/);
    expect(reasons["node_modules/x/index.js"]).toMatch(/generated/);
    expect(r.markdown).not.toContain("supersecretvalue123");
  });

  it("fits a tight budget by keeping only the relevant windows of big files", () => {
    const r = packContext("fix the escalation retry limit", files, 400);
    expect(r.tokensAfter).toBeLessThanOrEqual(480);
    expect(r.savedPct).toBeGreaterThan(80);
    const big = r.files.find((f) => f.path === "src/big.ts");
    if (big) {
      expect(big.truncated).toBe(true);
      expect(big.content).toContain("omitted");
    }
  });

  it("estimates tokens and caps output length", () => {
    expect(estimateTokens("abcd".repeat(100))).toBe(100);
    expect(estimateTokens("नमस्ते")).toBeGreaterThan(estimateTokens("hello"));
    const c = classifyTask("add a dark mode toggle");
    expect(suggestMaxTokens(c)).toBe(Math.round(c.estimatedOutputTokens * 1.25));
    expect(suggestMaxTokens(c, { attempts: 5, passes: 5, passRate: 1, avgOutputTokens: 800, scope: "exact" })).toBe(1200);
    expect(suggestMaxTokens(c, { attempts: 5, passes: 5, passRate: 1, avgOutputTokens: 10, scope: "exact" })).toBe(512);
  });
});

describe("Benchmark engine", () => {
  it("verifiers: contains / regex / json / node-test actually run code", async () => {
    expect((await verifierFor({ type: "contains", values: ["Smr"] })("about smr")).passed).toBe(true);
    expect((await verifierFor({ type: "contains", values: ["a", "b"], all: true })("a only")).passed).toBe(false);
    expect((await verifierFor({ type: "regex", pattern: "sql\\s*injection", flags: "i" })("SQL Injection!")).passed).toBe(true);
    expect((await verifierFor({ type: "json", requiredKeys: ["name"] })('```json\n{"name":"x"}\n```')).passed).toBe(true);
    expect((await verifierFor({ type: "json", requiredKeys: ["name"] })("nope")).passed).toBe(false);
    const test = "import assert from 'node:assert'; assert.strictEqual(add(2, 3), 5);";
    expect((await verifierFor({ type: "node-test", test })("Here:\n```js\nfunction add(a,b){return a+b}\n```")).passed).toBe(true);
    const wrong = await verifierFor({ type: "node-test", test })("```js\nfunction add(a,b){return a-b}\n```");
    expect(wrong.passed).toBe(false);
    expect(wrong.reason).toMatch(/test failed/);
    expect((await verifierFor({ type: "none" })("ESCALATE: too hard")).passed).toBe(false);
    expect(extractCode("text\n```python\nx\n```\n```js\ny\n```")).toBe("y\n");
  });

  const suite: BenchmarkSuite = {
    name: "mini",
    cases: [
      { id: "docs", task: "write README docs for the auth module", verify: { type: "contains", values: ["readme"] } },
      { id: "feat", task: "add a dark mode toggle to the settings page", verify: { type: "contains", values: ["toggle"] } },
    ],
  };

  it("runs strategies in isolation and compares cost AND success", async () => {
    const calls: string[] = [];
    const p: ProviderAdapter = {
      id: "anthropic",
      async complete(req) {
        calls.push(req.model);
        const text = req.prompt.includes("README") ? "README for auth" : "added a toggle";
        return { text, model: req.model, usage: { inputTokens: 1000, outputTokens: 500 } };
      },
    };
    const r = await runBenchmark(suite, { strategies: ["smr", "best", "single:anthropic/claude-sonnet-5-5"].map(parseStrategy), providers: new ProviderRegistry([p]) });
    expect(r.simulated).toBe(false);
    const by = Object.fromEntries(r.strategies.map((s) => [s.strategy, s]));
    expect(by.smr!.successRate).toBe(1);
    expect(r.results.find((x) => x.strategy === "smr" && x.caseId === "docs")!.finalModel).toBe(HAIKU);
    expect(r.results.filter((x) => x.strategy === "best").every((x) => x.finalModel === "anthropic/claude-opus-5-5")).toBe(true);
    expect(by.smr!.costUnits).toBeLessThan(by.best!.costUnits);
    expect(r.comparisons.find((c) => c.baseline === "best")!.verdict).toBe("pass");
  });

  it("FAILS SMR when it saves money by failing tasks", async () => {
    const p: ProviderAdapter = {
      id: "anthropic",
      async complete(req) {
        // haiku answers docs wrongly; every other model is right
        const text = req.model.includes("haiku") ? "something else" : "README for auth";
        return { text, model: req.model, usage: { inputTokens: 1000, outputTokens: 500 } };
      },
    };
    const one: BenchmarkSuite = { name: "x", cases: [suite.cases[0]!] };
    const r = await runBenchmark(one, { strategies: [parseStrategy("smr"), parseStrategy("best")], providers: new ProviderRegistry([p]), policy: { maxRetriesPerModel: 1, maxEscalations: 0 } });
    const cmp = r.comparisons[0]!;
    expect(cmp.successDeltaPts).toBeLessThan(0);
    expect(cmp.verdict).toBe("fail");
  });

  it("simulation is deterministic per seed and clearly marked", async () => {
    const a = await runBenchmark(suite, { strategies: [parseStrategy("smr")], simulate: { seed: 3 } });
    const b = await runBenchmark(suite, { strategies: [parseStrategy("smr")], simulate: { seed: 3 } });
    expect(a.simulated).toBe(true);
    expect(a.results.map((x) => [x.passed, x.modelsUsed])).toEqual(b.results.map((x) => [x.passed, x.modelsUsed]));
  });

  it("imports results into the main log for learning", async () => {
    const r = await runBenchmark(suite, { strategies: [parseStrategy("smr")], simulate: { seed: 1 } });
    const store = new JsonStore();
    const n = importBenchmark(store, r);
    expect(n).toBe(r.results.reduce((s, x) => s + x.attempts, 0));
    expect(store.listTasks()[0]!.text).toMatch(/^\[bench:mini\//);
    expect(store.performanceStats().length).toBeGreaterThan(0);
  });
});

describe("Insights + dashboard", () => {
  it("estimates savings vs always-best on the same tokens", () => {
    const store = new JsonStore();
    const s = new TaskSession(store);
    const t = s.start("write README docs", classifyTask("write README docs"));
    s.recordAttempt(t.id, { model: "haiku", passed: true, inputTokens: 10_000, outputTokens: 1_000 });
    const sv = estimateSavings(store);
    expect(sv.baselineModel).toBe("anthropic/claude-opus-5-5");
    expect(sv.unit).toBe("cost-units");
    expect(sv.savedPct).toBe(80); // haiku ×1 vs opus ×5 on identical tokens
  });

  it("renders a self-contained, escaped HTML dashboard", () => {
    const store = new JsonStore();
    const s = new TaskSession(store);
    const t = s.start("<script>alert(1)</script> fix typo in README", classifyTask("fix typo in README"));
    s.recordAttempt(t.id, { model: "haiku", passed: true, inputTokens: 100, outputTokens: 10 });
    const html = renderDashboard(buildDashboardData(store));
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    for (const h of ["Cost by model", "Pass rate by model × category", "Benchmarks", "Learning engine", "Recent tasks"]) expect(html).toContain(h);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/https?:\/\/(?!localhost)[^"'\s)]*\.(js|css)/); // no CDN assets
    expect(html).toContain("✓ Completed");
  });
});
