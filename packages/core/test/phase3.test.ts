import { describe, expect, it } from "vitest";
import {
  classifyTask,
  executeTask,
  JsonStore,
  ModelRegistry,
  ProviderError,
  ProviderRegistry,
  routeTask,
  TaskSession,
  usageFromTranscript,
  type FetchLike,
  type ProviderAdapter,
} from "../src/index.js";

type Call = { url: string; headers: Record<string, string>; body: any };

function mockFetch(reply: (c: Call) => { status?: number; json: unknown }): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url, init) => {
    const c = { url, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(c);
    const r = reply(c);
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.json, text: async () => JSON.stringify(r.json) };
  }) as FetchLike & { calls: Call[] };
  f.calls = calls;
  return f;
}

describe("Provider adapters", () => {
  const env = { ANTHROPIC_API_KEY: "a-key", OPENAI_API_KEY: "o-key", OPENROUTER_API_KEY: "r-key", GEMINI_API_KEY: "g-key" };
  const withEnv = async (fn: () => Promise<void>) => {
    const old = { ...process.env };
    Object.assign(process.env, env);
    try { await fn(); } finally { process.env = old; }
  };

  it("Anthropic: request shape + usage incl. cache tokens", () => withEnv(async () => {
    const f = mockFetch(() => ({ json: { model: "claude-haiku-5-5", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 } } }));
    const r = await ProviderRegistry.defaults({ fetch: f }).complete("anthropic/claude-haiku-5-5", { prompt: "p", system: "s" });
    expect(r).toEqual({ text: "hi", model: "claude-haiku-5-5", usage: { inputTokens: 15, outputTokens: 3 } });
    expect(f.calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(f.calls[0]!.headers["x-api-key"]).toBe("a-key");
    expect(f.calls[0]!.body).toMatchObject({ model: "claude-haiku-5-5", system: "s" });
  }));

  it("OpenAI / OpenRouter / Ollama share the chat-completions shape", () => withEnv(async () => {
    const f = mockFetch(() => ({ json: { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 7, completion_tokens: 2 } } }));
    const p = ProviderRegistry.defaults({ fetch: f });
    await p.complete("openai/gpt-x", { prompt: "p" });
    await p.complete("openrouter/vendor/model-y", { prompt: "p" });
    const r = await p.complete("ollama/qwen3", { prompt: "p" });
    expect(r.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://api.openai.com/v1/chat/completions",
      "https://openrouter.ai/api/v1/chat/completions",
      "http://localhost:11434/v1/chat/completions",
    ]);
    expect(f.calls[0]!.body.max_completion_tokens).toBeDefined();
    expect(f.calls[1]!.body.model).toBe("vendor/model-y");
    expect(f.calls[1]!.headers.authorization).toBe("Bearer r-key");
    expect(f.calls[2]!.headers.authorization).toBeUndefined();
  }));

  it("Google Gemini", () => withEnv(async () => {
    const f = mockFetch(() => ({ json: { candidates: [{ content: { parts: [{ text: "g" }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } } }));
    const r = await ProviderRegistry.defaults({ fetch: f }).complete("google/gemini-x", { prompt: "p" });
    expect(r.text).toBe("g");
    expect(f.calls[0]!.url).toContain("/models/gemini-x:generateContent");
    expect(f.calls[0]!.headers["x-goog-api-key"]).toBe("g-key");
  }));

  it("errors: HTTP status, missing key, unknown provider — and never leaks the key", () => withEnv(async () => {
    const f = mockFetch(() => ({ status: 429, json: { error: "rate limited" } }));
    const err = await ProviderRegistry.defaults({ fetch: f }).complete("anthropic/m", { prompt: "p" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect(String(err.message)).not.toContain("a-key");
    delete process.env.OPENAI_API_KEY;
    await expect(ProviderRegistry.defaults({ fetch: f }).complete("openai/m", { prompt: "p" })).rejects.toThrow(/OPENAI_API_KEY/);
    expect(() => ProviderRegistry.defaults().resolve("mystery/m")).toThrow(/No provider adapter/);
    expect(() => ProviderRegistry.defaults().resolve("nomodelprefix")).toThrow();
  }));
});

describe("Direct executor", () => {
  const scripted = (answers: Record<string, string[]>): ProviderAdapter & { seen: string[] } => {
    const seen: string[] = [];
    return {
      id: "anthropic",
      seen,
      async complete(req) {
        seen.push(req.model);
        const next = answers[req.model]?.shift();
        if (next === undefined) throw new ProviderError(503, "overloaded");
        return { text: next, model: req.model, usage: { inputTokens: 100, outputTokens: 20 } };
      },
    };
  };

  it("cheap model succeeds → done in one call, usage logged", async () => {
    const store = new JsonStore();
    const p = scripted({ "claude-haiku-5-5": ["# README\n..."] });
    const text = "write README docs for the auth module";
    const r = await executeTask(text, classifyTask(text), { store, providers: new ProviderRegistry([p]) });
    expect(r).toMatchObject({ status: "completed", finalModel: "anthropic/claude-haiku-5-5", attempts: 1 });
    expect(r.output).toContain("README");
    expect(store.modelStats()[0]).toMatchObject({ inputTokens: 100, outputTokens: 20 });
  });

  it("ESCALATE answer skips the retry and moves up a tier; handoff carries the failure", async () => {
    const store = new JsonStore();
    const p = scripted({ "claude-haiku-5-5": ["ESCALATE: needs multi-file context"], "claude-sonnet-5-5": ["done"] });
    const text = "write README docs for the auth module";
    const r = await executeTask(text, classifyTask(text), { store, providers: new ProviderRegistry([p]) });
    expect(p.seen).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect(r.finalModel).toBe("anthropic/claude-sonnet-5-5");
  });

  it("provider outages escalate, then stop at the limit without looping", async () => {
    const store = new JsonStore();
    const p = scripted({});
    const text = "add a dark mode toggle";
    const r = await executeTask(text, classifyTask(text), { store, providers: new ProviderRegistry([p]) });
    expect(r.status).toBe("stopped");
    expect(r.output).toBeUndefined();
    expect(p.seen.length).toBeLessThanOrEqual(3);
  });

  it("custom verifier drives retries", async () => {
    const store = new JsonStore();
    const p = scripted({ "claude-sonnet-5-5": ["bad", "good"] });
    const text = "add a dark mode toggle";
    const r = await executeTask(text, classifyTask(text), {
      store, providers: new ProviderRegistry([p]),
      verifier: async (o) => (o === "good" ? { passed: true } : { passed: false, reason: "missing toggle" }),
    });
    expect(p.seen).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
    expect(r.output).toBe("good");
  });
});

describe("Hooks: transcript usage", () => {
  it("sums assistant usage, dedupes streamed lines, ignores junk", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { content: "x" } }),
      JSON.stringify({ type: "assistant", message: { id: "a", model: "claude-haiku-5-5", usage: { input_tokens: 10, cache_creation_input_tokens: 2, output_tokens: 5 } } }),
      JSON.stringify({ type: "assistant", message: { id: "a", model: "claude-haiku-5-5", usage: { input_tokens: 10, output_tokens: 5 } } }),
      JSON.stringify({ type: "assistant", message: { id: "b", model: "claude-haiku-5-5", usage: { input_tokens: 1, output_tokens: 1 } } }),
      "{broken",
    ].join("\n");
    expect(usageFromTranscript(jsonl)).toEqual({ model: "claude-haiku-5-5", inputTokens: 13, outputTokens: 6, messages: 2 });
  });

  it("pending usage attaches to the next attempt of that model only", () => {
    const store = new JsonStore();
    const s = new TaskSession(store, undefined, undefined, "claude-code");
    const t = s.start("add a dark mode toggle", classifyTask("add a dark mode toggle"));
    s.addPendingUsage("claude-sonnet-5-5", 900, 100);
    s.addPendingUsage("sonnet", 100, 50);
    const a = s.recordAttempt(t.id, { model: "sonnet", passed: false }).attempt;
    expect([a.inputTokens, a.outputTokens]).toEqual([1000, 150]);
    expect(s.recordAttempt(t.id, { model: "sonnet", passed: true }).attempt.inputTokens).toBeUndefined();
  });
});

describe("Host-aware routing", () => {
  it("codex gets SMR agent roles; decisions remember their host", () => {
    expect(routeTask("add a dark mode toggle", { host: "codex" }).decision.hostModel).toBe("smr-builder");
    expect(routeTask("security audit of payment gateway integration", { host: "codex" }).decision.hostModel).toBe("smr-architect");
    const s = new TaskSession(new JsonStore(), undefined, undefined, "claude-code");
    const t = s.start("add a dark mode toggle", classifyTask("add a dark mode toggle"));
    const generic = new TaskSession((s as any).store, new ModelRegistry(), undefined, "generic");
    generic.recordAttempt(t.id, { model: "sonnet", passed: false });
    expect(generic.recordAttempt(t.id, { model: "sonnet", passed: false }).next.hostModel).toBe("opus");
  });
});
