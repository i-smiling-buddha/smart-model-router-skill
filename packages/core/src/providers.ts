/**
 * Provider & Execution Layer — talk to models directly (for custom agents, `smr exec`,
 * the LLM classifier, and hosts that can't switch models themselves).
 *
 * Registry model ids are "<provider>/<model>":
 *   anthropic/claude-sonnet-5-5      → Anthropic Messages API        (ANTHROPIC_API_KEY)
 *   openai/<model>                   → OpenAI Chat Completions        (OPENAI_API_KEY)
 *   openrouter/<vendor>/<model>      → OpenRouter (OpenAI-compatible) (OPENROUTER_API_KEY)
 *   google/<model>                   → Gemini generateContent         (GEMINI_API_KEY)
 *   ollama/<model>                   → local Ollama (OpenAI-compatible, no key; OLLAMA_HOST)
 *
 * Keys come from the environment only. They are never logged, stored, or put in prompts.
 */

export interface CompletionRequest {
  model: string; // provider-local model name (without the "<provider>/" prefix)
  prompt: string;
  system?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Ask the provider to cache the (stable) system prompt where supported (Anthropic). */
  cacheSystem?: boolean;
}

export interface CompletionResult {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ProviderAdapter {
  readonly id: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

interface AdapterOpts { apiKey?: string; baseUrl?: string; fetch?: FetchLike }

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT = 120_000;

async function post(f: FetchLike, url: string, headers: Record<string, string>, body: unknown, timeoutMs?: number): Promise<any> {
  const res = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    throw new ProviderError(res.status, detail);
  }
  return res.json();
}

export class ProviderError extends Error {
  constructor(readonly status: number, detail: string) {
    // Never echo request headers; response bodies don't contain our key.
    super(`provider HTTP ${status}${detail ? `: ${detail.replace(/\s+/g, " ")}` : ""}`);
  }
  /** 429 / 5xx / overloaded are worth a fallback to another model. */
  get retryable(): boolean { return this.status === 429 || this.status >= 500; }
}

const requireKey = (key: string | undefined, env: string): string => {
  if (!key) throw new Error(`${env} is not set`);
  return key;
};

export function anthropicProvider(o: AdapterOpts = {}): ProviderAdapter {
  const f = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = (o.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  return {
    id: "anthropic",
    async complete(req) {
      const key = requireKey(o.apiKey ?? process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY");
      const body: Record<string, unknown> = {
        model: req.model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: [{ role: "user", content: req.prompt }],
      };
      if (req.system) {
        body.system = req.cacheSystem
          ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
          : req.system;
      }
      const r = await post(f, `${base}/v1/messages`, { "x-api-key": key, "anthropic-version": "2023-06-01" }, body, req.timeoutMs);
      const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join("");
      return {
        text,
        model: r.model ?? req.model,
        usage: {
          inputTokens: (r.usage?.input_tokens ?? 0) + (r.usage?.cache_read_input_tokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0),
          outputTokens: r.usage?.output_tokens ?? 0,
        },
      };
    },
  };
}

/** Any OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, Ollama, LM Studio, vLLM...). */
export function openAICompatibleProvider(
  o: AdapterOpts & { id: string; envKey?: string; maxTokensField?: "max_tokens" | "max_completion_tokens"; extraHeaders?: Record<string, string> },
): ProviderAdapter {
  const f = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = (o.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  return {
    id: o.id,
    async complete(req) {
      const headers: Record<string, string> = { ...o.extraHeaders };
      if (o.envKey) headers.authorization = `Bearer ${requireKey(o.apiKey ?? process.env[o.envKey], o.envKey)}`;
      const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.prompt }];
      const r = await post(f, `${base}/chat/completions`, headers, {
        model: req.model,
        messages,
        [o.maxTokensField ?? "max_tokens"]: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      }, req.timeoutMs);
      const content = r.choices?.[0]?.message?.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => p.text ?? "").join("") : "";
      return {
        text,
        model: r.model ?? req.model,
        usage: { inputTokens: r.usage?.prompt_tokens ?? 0, outputTokens: r.usage?.completion_tokens ?? 0 },
      };
    },
  };
}

export function googleProvider(o: AdapterOpts = {}): ProviderAdapter {
  const f = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = (o.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  return {
    id: "google",
    async complete(req) {
      const key = requireKey(o.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY, "GEMINI_API_KEY");
      const body: Record<string, unknown> = {
        contents: [{ role: "user", parts: [{ text: req.prompt }] }],
        generationConfig: { maxOutputTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS },
      };
      if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
      const r = await post(f, `${base}/models/${encodeURIComponent(req.model)}:generateContent`, { "x-goog-api-key": key }, body, req.timeoutMs);
      const text = (r.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
      return {
        text,
        model: r.modelVersion ?? req.model,
        usage: { inputTokens: r.usageMetadata?.promptTokenCount ?? 0, outputTokens: r.usageMetadata?.candidatesTokenCount ?? 0 },
      };
    },
  };
}

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(adapters: ProviderAdapter[] = []) {
    for (const a of adapters) this.adapters.set(a.id, a);
  }

  /** Built-in providers; pass `fetch` to mock in tests. */
  static defaults(opts: { fetch?: FetchLike } = {}): ProviderRegistry {
    const f = opts.fetch;
    return new ProviderRegistry([
      anthropicProvider({ fetch: f }),
      openAICompatibleProvider({ id: "openai", envKey: "OPENAI_API_KEY", maxTokensField: "max_completion_tokens", fetch: f }),
      openAICompatibleProvider({ id: "openrouter", envKey: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api/v1", fetch: f, extraHeaders: { "x-title": "Smart Model Router" } }),
      googleProvider({ fetch: f }),
      openAICompatibleProvider({ id: "ollama", baseUrl: `${(process.env.OLLAMA_HOST ?? "http://localhost:11434").replace(/\/$/, "")}/v1`, fetch: f }),
    ]);
  }

  register(a: ProviderAdapter): this { this.adapters.set(a.id, a); return this; }

  /** "openrouter/meta/llama-x" → { adapter: openrouter, model: "meta/llama-x" } */
  resolve(modelId: string): { adapter: ProviderAdapter; model: string } {
    const i = modelId.indexOf("/");
    if (i <= 0) throw new Error(`Model id "${modelId}" must look like "<provider>/<model>"`);
    const provider = modelId.slice(0, i);
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`No provider adapter for "${provider}". Known: ${[...this.adapters.keys()].join(", ")}`);
    return { adapter, model: modelId.slice(i + 1) };
  }

  async complete(modelId: string, req: Omit<CompletionRequest, "model">): Promise<CompletionResult> {
    const { adapter, model } = this.resolve(modelId);
    return adapter.complete({ ...req, model });
  }
}
