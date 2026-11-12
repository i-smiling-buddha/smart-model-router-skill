import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyTask,
  classifyWithFallback,
  detectChecks,
  evaluate,
  JsonStore,
  openStore,
  parseLlmAnswer,
  TaskSession,
  type CommandRunner,
  type ExecutionStore,
  type LlmBackend,
} from "../src/index.js";

const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";

const fakeRunner = (results: Record<string, number>): CommandRunner & { calls: string[] } => {
  const calls: string[] = [];
  const fn = (async (cmd: string) => {
    calls.push(cmd);
    return { exitCode: results[cmd] ?? 0, output: `ran ${cmd}\n> echo noise\nFAILED: expected x`, timedOut: false };
  }) as CommandRunner & { calls: string[] };
  fn.calls = calls;
  return fn;
};

describe("Quality Evaluator", () => {
  const checks = [
    { name: "typecheck", command: "tc", level: "static" as const },
    { name: "test", command: "t", level: "functional" as const },
  ];

  it("runs static then functional for normal implementation", async () => {
    const runner = fakeRunner({});
    const r = await evaluate(classifyTask("add a dark mode toggle"), { checks, runner });
    expect(r.passed).toBe(true);
    expect(runner.calls).toEqual(["tc", "t"]);
    expect(r.semanticChecklist.length).toBeGreaterThan(0);
  });

  it("skips tests when static fails (fail fast)", async () => {
    const runner = fakeRunner({ tc: 1 });
    const r = await evaluate(classifyTask("add a dark mode toggle"), { checks, runner });
    expect(r.passed).toBe(false);
    expect(runner.calls).toEqual(["tc"]);
    expect(r.skipped.map((s) => s.name)).toContain("test");
    expect(r.failureSummary).toContain("FAILED: expected x");
    expect(r.failureSummary).not.toContain("> echo noise");
  });

  it("never runs a test suite for docs", async () => {
    const runner = fakeRunner({});
    const r = await evaluate(classifyTask("write README docs for the auth module"), { checks, runner });
    expect(runner.calls).toEqual([]);
    expect(r.levelsRequested).toEqual(["semantic"]);
  });

  it("detects checks from package.json scripts", () => {
    const dir = mkdtempSync(join(tmpdir(), "smr-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run", build: "tsc" } }));
    const c = detectChecks(dir);
    expect(c.map((x) => `${x.level}:${x.name}`)).toEqual(["static:lint", "static:build", "functional:test"]);
  });

  it("runs real shell commands", async () => {
    const r = await evaluate(classifyTask("add a dark mode toggle"), {
      checks: [{ name: "ok", command: "node -e \"process.exit(0)\"", level: "static" }, { name: "bad", command: "node -e \"process.exit(3)\"", level: "functional" }],
    });
    expect(r.results.map((x) => [x.name, x.passed, x.exitCode])).toEqual([["ok", true, 0], ["bad", false, 3]]);
  });
});

const stores: [string, () => ExecutionStore][] = [
  ["memory", () => new JsonStore()],
  ["json", () => openStore(mkdtempSync(join(tmpdir(), "smr-")), { backend: "json" })],
  ["sqlite", () => openStore(mkdtempSync(join(tmpdir(), "smr-")), { backend: "sqlite" })],
];

describe.each(stores)("Execution store (%s) + retry management", (_name, make) => {
  it("drives retry → escalate → complete from logged history", () => {
    const store = make();
    const s = new TaskSession(store, undefined, undefined, "claude-code");
    const text = "add a dark mode toggle to the settings page";
    const t = s.start(text, classifyTask(text));
    expect(t.decision.hostModel).toBe("sonnet");
    expect(s.next(t.id).action).toBe("retry");

    expect(s.recordAttempt(t.id, { model: "sonnet", passed: false, failureReason: "test failed" }).next.action).toBe("retry");
    const esc = s.recordAttempt(t.id, { model: SONNET, passed: false, inputTokens: 1000, outputTokens: 500 }).next;
    expect(esc.action).toBe("escalate");
    expect(esc.hostModel).toBe("opus");

    const done = s.recordAttempt(t.id, { model: "opus", passed: true });
    expect(done.next.action).toBe("complete");
    const rec = store.getTask(t.id)!;
    expect(rec.task.status).toBe("completed");
    expect(rec.attempts).toHaveLength(3);

    const stats = store.modelStats();
    expect(stats.find((m) => m.modelId === SONNET)).toMatchObject({ attempts: 2, passes: 0, inputTokens: 1000, costUsd: null });
    expect(stats.find((m) => m.modelId === OPUS)?.passRate).toBe(1);
    expect(store.categoryStats()).toContainEqual({ category: "development", modelId: OPUS, attempts: 1, passRate: 1 });
    expect(store.listTasks()[0]!.id).toBe(t.id);

    expect(s.handoff(t.id, { constraints: ["Keep theme API"] })).toContain("Keep theme API");
    expect(() => store.addAttempt({ taskId: "nope", modelId: OPUS, passed: true })).toThrow();
    // secrets never land in the log
    const secretTask = store.createTask("deploy with key sk-ant-abcdefghijklmnop12345", t.classification, t.decision);
    expect(secretTask.text).not.toContain("sk-ant-abcdefghijklmnop12345");
    const sa = store.addAttempt({ taskId: t.id, modelId: OPUS, passed: false, failureReason: "auth failed for token: ghp_abcdefghijklmnopqrstuvwx" });
    expect(store.getTask(t.id)!.attempts.find((x) => x.id === sa.id)!.failureReason).not.toContain("ghp_abcdefghijklmnopqrstuvwx");
    store.cacheSet("k", "v");
    expect(store.cacheGet("k")).toBe("v");
    store.close();
  });
});

describe("LLM fallback classifier", () => {
  const backend = (answer: string): LlmBackend & { calls: number } => {
    const b = { name: "mock", calls: 0, async complete() { b.calls++; return answer; } };
    return b;
  };

  it("is not called when rule confidence is high", async () => {
    const b = backend("{}");
    await classifyWithFallback("security audit of payment gateway integration", { backend: b });
    expect(b.calls).toBe(0);
  });

  it("refines low-confidence tasks and caches the answer", async () => {
    const b = backend('Sure: {"category":"planning","complexity":3,"riskLevel":"medium"}');
    const cache = new JsonStore();
    const task = "hmm what should we do about the onboarding thing";
    expect(classifyTask(task).confidence).toBeLessThan(0.6);
    const c1 = await classifyWithFallback(task, { backend: b, cache });
    expect(c1.category).toBe("planning");
    expect(c1.complexity).toBe(3);
    await classifyWithFallback(task, { backend: b, cache });
    expect(b.calls).toBe(1);
  });

  it("can never lower rule-detected risk", async () => {
    const b = backend('{"category":"documentation","complexity":1,"riskLevel":"low"}');
    const c = await classifyWithFallback("our secrets thing", { backend: b, threshold: 1 });
    expect(c.riskLevel).toBe("critical");
    expect(c.complexity).toBe(4);
  });

  it("falls back to rules on garbage or errors", async () => {
    expect(parseLlmAnswer("no json here")).toBeUndefined();
    const c = await classifyWithFallback("hmm the onboarding thing", { backend: backend("nope") });
    expect(c.signals.join(" ")).toMatch(/unusable/);
    const failing: LlmBackend = { name: "x", complete: async () => { throw new Error("network down"); } };
    const c2 = await classifyWithFallback("hmm the onboarding thing", { backend: failing });
    expect(c2.signals.join(" ")).toMatch(/network down/);
  });
});
