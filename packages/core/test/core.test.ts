import { describe, expect, it } from "vitest";
import {
  buildHandoff,
  classifyTask,
  decideNext,
  estimateCost,
  ModelRegistry,
  redactSecrets,
  Router,
  routeTask,
  DEFAULT_REGISTRY,
} from "../src/index.js";

const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const pick = (task: string, mode?: "smart" | "economy" | "quality") => routeTask(task, { mode }).decision.selectedModel;

describe("Task Classifier", () => {
  it.each([
    ["fix typo in README", "documentation", 1],
    ["find where the login handler is", "research", 2],
    ["add a dark mode toggle to the settings page", "development", 2],
    ["debug race condition in the websocket reconnect logic", "debugging", 3],
    ["write unit tests for the cart utils", "testing", 2],
    ["refactor the slow image pipeline", "optimization", 2],
  ] as const)("%s → %s (complexity %i)", (task, category, complexity) => {
    const c = classifyTask(task);
    expect(c.category).toBe(category);
    expect(c.complexity).toBe(complexity);
  });

  it("flags security / payments as critical", () => {
    const c = classifyTask("security audit of payment gateway integration");
    expect(c.category).toBe("review");
    expect(c.subcategory).toBe("security-audit");
    expect(c.riskLevel).toBe("critical");
    expect(c.complexity).toBe(4);
  });

  it("understands Hindi + Hinglish", () => {
    expect(classifyTask("लॉगिन बग ठीक करो").category).toBe("debugging");
    const c = classifyTask("पूरा authentication system बनाओ");
    expect(c.category).toBe("development");
    expect(c.complexity).toBeGreaterThanOrEqual(3);
  });

  it("gives stable task ids and rejects empty input", () => {
    expect(classifyTask("x y").taskId).toBe(classifyTask("x y").taskId);
    expect(() => classifyTask("   ")).toThrow();
  });
});

describe("Intelligent Router", () => {
  it("cheap model for simple / docs / exploration work", () => {
    expect(pick("fix typo in README")).toBe(HAIKU);
    expect(pick("write README docs for the auth module")).toBe(HAIKU);
    expect(pick("find where the login handler is")).toBe(HAIKU);
  });

  it("strong coder for normal implementation", () => {
    expect(pick("add a dark mode toggle to the settings page")).toBe(SONNET);
  });

  it("advanced model for complex debugging and critical work", () => {
    expect(pick("debug race condition in the websocket reconnect logic")).toBe(OPUS);
    expect(pick("security audit of payment gateway integration")).toBe(OPUS);
  });

  it("economy mode trades down when quality floor still holds", () => {
    expect(pick("build the entire e-commerce backend from scratch with cart and orders", "economy")).toBe(SONNET);
  });

  it("critical tasks never go to a model below the reliability floor, even in economy mode", () => {
    expect(pick("security audit of payment gateway integration", "economy")).toBe(OPUS);
  });

  it("maps to host aliases and lists stronger fallbacks", () => {
    const { decision } = routeTask("add a dark mode toggle", { host: "claude-code" });
    expect(decision.hostModel).toBe("sonnet");
    expect(decision.fallbackModels).toContain(OPUS);
    expect(decision.fallbackModels).not.toContain(HAIKU);
  });

  it("respects exclusions and unavailable models", () => {
    const c = classifyTask("add a dark mode toggle");
    const d = new Router().route(c, { exclude: [SONNET] });
    expect(d.selectedModel).not.toBe(SONNET);
    expect(d.candidates.find((x) => x.modelId === "anthropic/claude-fable-5-2")?.rejectedReason).toBe("unavailable");
  });

  it("vision tasks skip models without vision", () => {
    const reg = new ModelRegistry({
      version: 1,
      models: DEFAULT_REGISTRY.models.map((m) => (m.id === SONNET ? { ...m, capabilities: { ...m.capabilities, vision: false } } : m)),
    });
    const c = classifyTask("build this settings page from the screenshot");
    expect(c.visionRequired).toBe(true);
    expect(new Router(reg).route(c).selectedModel).not.toBe(SONNET);
  });
});

describe("Cost", () => {
  it("returns USD only when pricing is configured", () => {
    const haiku = DEFAULT_REGISTRY.models[0]!;
    expect(estimateCost(haiku, 10_000, 2_000).usd).toBeNull();
    const priced = { ...haiku, pricing: { inputPerMTok: 1, outputPerMTok: 5 } };
    expect(estimateCost(priced, 1_000_000, 100_000).usd).toBeCloseTo(1.5);
  });
});

describe("Escalation", () => {
  const task = classifyTask("add a dark mode toggle");
  it("retries once, then escalates, then stops at the limit", () => {
    expect(decideNext(task, [{ modelId: SONNET, passed: false }]).action).toBe("retry");
    const esc = decideNext(task, [{ modelId: SONNET, passed: false }, { modelId: SONNET, passed: false }]);
    expect(esc.action).toBe("escalate");
    expect(esc.modelId).toBe(OPUS);
    const stop = decideNext(task, [
      { modelId: HAIKU, passed: false }, { modelId: HAIKU, passed: false },
      { modelId: SONNET, passed: false }, { modelId: SONNET, passed: false },
      { modelId: OPUS, passed: false }, { modelId: OPUS, passed: false },
    ]);
    expect(stop.action).toBe("stop");
  });

  it("completes on pass and honours the cost ceiling", () => {
    expect(decideNext(task, [{ modelId: SONNET, passed: true }]).action).toBe("complete");
    const d = decideNext(task, [{ modelId: SONNET, passed: false, costUsd: 0.5 }], undefined, {
      maxRetriesPerModel: 2, maxEscalations: 2, costCeilingUsd: 0.4,
    });
    expect(d.action).toBe("stop");
  });

  it("skips pointless retries on capability failures", () => {
    const d = decideNext(task, [{ modelId: SONNET, passed: false, failureReason: "context window exceeded" }]);
    expect(d.action).toBe("escalate");
  });
});

describe("Context handoff", () => {
  it("keeps constraints, drops sensitive files, redacts secrets", () => {
    const md = buildHandoff({
      task: "Implement JWT auth",
      originalRequirement: "Users log in with email + password",
      constraints: ["Preserve existing API compatibility"],
      userDecisions: ["Use Prisma"],
      relevantFiles: ["src/auth/auth.service.ts", ".env", "certs/server.pem"],
      findings: ["api_key = sk-ant-abcdefghijklmnop123"],
    });
    expect(md).toContain("Preserve existing API compatibility");
    expect(md).toContain("Use Prisma");
    expect(md).toContain("src/auth/auth.service.ts");
    expect(md).not.toContain(".env");
    expect(md).not.toContain("server.pem");
    expect(md).not.toContain("sk-ant-abcdefghijklmnop123");
  });

  it("trims optional blocks to budget but never constraints", () => {
    const md = buildHandoff(
      {
        task: "t",
        originalRequirement: "r",
        constraints: ["MUST-KEEP"],
        snippets: [{ path: "big.ts", code: "x".repeat(50_000) }],
      },
      { maxTokens: 500 },
    );
    expect(md).toContain("MUST-KEEP");
    expect(md).not.toContain("x".repeat(1000));
    expect(md).toContain("omitted");
  });

  it("redacts common key formats", () => {
    expect(redactSecrets("token: ghp_abcdefghijklmnopqrstuvwx")).not.toContain("ghp_abcdefghijklmnopqrstuvwx");
  });
});
