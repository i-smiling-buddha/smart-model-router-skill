import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  anthropicBackend,
  classifyTask,
  classifyWithFallback,
  detectChecks,
  evaluate,
  executeTask,
  ModelRegistry,
  openStore,
  policyFor,
  ProviderRegistry,
  providerBackend,
  Router,
  routerOptsFor,
  storeDirFor,
  TaskSession,
  historyFor,
  learningReport,
  packContext,
  collectFiles,
  type ContextFile,
  type ExecutionStore,
  type HostId,
  type RouterOptions,
  type RoutingMode,
  type SmrConfig,
  type TaskClassification,
} from "@smr/core";

/**
 * Common SMR API — one set of operations, exposed over HTTP (`smr serve`) and MCP (`smr mcp`).
 * Same task schema, same routing logic, same result format on every host.
 */

export interface ApiContext {
  cfg: SmrConfig;
  registry: ModelRegistry;
  providers: ProviderRegistry;
  store(): ExecutionStore;
  /** Router options incl. Learning Engine history from the log. */
  routing(overrides?: { mode?: RoutingMode; host?: HostId }): RouterOptions & { host: HostId };
  cwd: string;
}

export function createContext(cfg: SmrConfig, opts: { registry?: ModelRegistry; providers?: ProviderRegistry; store?: ExecutionStore; cwd?: string } = {}): ApiContext {
  let store = opts.store;
  const getStore = () => (store ??= openStore(storeDirFor(cfg)));
  return {
    cfg,
    registry: opts.registry ?? new ModelRegistry(),
    providers: opts.providers ?? ProviderRegistry.defaults(),
    store: getStore,
    routing: (o = {}) => ({ ...routerOptsFor(cfg, o), history: historyFor(cfg, getStore()) }),
    cwd: opts.cwd ?? process.cwd(),
  };
}

const Host = z.enum(["claude-code", "opencode", "codex", "generic"]).optional();
const Mode = z.enum(["smart", "economy", "quality"]).optional();

export interface Operation<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  input: S;
  /** JSON Schema for MCP tools/list (kept explicit — no extra dependency). */
  jsonSchema: Record<string, unknown>;
  run(ctx: ApiContext, input: z.infer<S>): Promise<unknown>;
}

const str = (description: string) => ({ type: "string", description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

async function classify(ctx: ApiContext, task: string, llm?: boolean): Promise<TaskClassification> {
  const want = llm ?? !!ctx.cfg.llmClassifier?.enabled;
  if (!want) return classifyTask(task);
  const model = ctx.cfg.llmClassifier?.model ?? "claude-haiku-5-5";
  let backend;
  try {
    backend = model.includes("/") ? providerBackend(ctx.providers, model) : anthropicBackend({ model });
  } catch {
    return classifyTask(task);
  }
  return classifyWithFallback(task, { backend, threshold: ctx.cfg.llmClassifier?.threshold, cache: ctx.store() });
}

const session = (ctx: ApiContext, host?: string) =>
  new TaskSession(ctx.store(), ctx.registry, policyFor(ctx.cfg), (host ?? ctx.cfg.host ?? "generic") as HostId, ctx.routing({ host: host as HostId | undefined }));

function op<S extends z.ZodTypeAny>(o: Operation<S>): Operation<S> { return o; }

export const OPERATIONS = [
  op({
    name: "smr_route",
    description: "Pick the cheapest model that can reliably complete a coding task. Returns the model (with host alias), reason, success probability, fallbacks and which verification levels to run.",
    input: z.object({ task: z.string().min(1), mode: Mode, host: Host, llm: z.boolean().optional() }),
    jsonSchema: obj({ task: str("The task in the user's words"), mode: { type: "string", enum: ["smart", "economy", "quality"] }, host: { type: "string", enum: ["claude-code", "opencode", "codex", "generic"] }, llm: { type: "boolean" } }, ["task"]),
    async run(ctx, i) {
      const c = await classify(ctx, i.task, i.llm);
      const d = new Router(ctx.registry).route(c, ctx.routing({ mode: i.mode, host: i.host }));
      return { classification: c, decision: { ...d, candidates: undefined } };
    },
  }),
  op({
    name: "smr_classify",
    description: "Classify a task: category, complexity (1-4), risk level, confidence.",
    input: z.object({ task: z.string().min(1), llm: z.boolean().optional() }),
    jsonSchema: obj({ task: str("The task"), llm: { type: "boolean" } }, ["task"]),
    run: (ctx, i) => classify(ctx, i.task, i.llm),
  }),
  op({
    name: "smr_task_start",
    description: "Open a logged task and get the routed model. Keep the taskId for verify/attempt/next.",
    input: z.object({ task: z.string().min(1), host: Host }),
    jsonSchema: obj({ task: str("The task in the user's words"), host: { type: "string", enum: ["claude-code", "opencode", "codex", "generic"] } }, ["task"]),
    async run(ctx, i) {
      const t = session(ctx, i.host).start(i.task, await classify(ctx, i.task));
      return { taskId: t.id, hostModel: t.decision.hostModel, model: t.decision.selectedModel, reason: t.decision.routingReason, verificationLevels: t.decision.verificationLevels };
    },
  }),
  op({
    name: "smr_task_attempt",
    description: "Record the outcome of one attempt (pass/fail, optional tokens). Returns the next action: retry, escalate (with model), stop, or complete.",
    input: z.object({
      taskId: z.string(), model: z.string(), passed: z.boolean(), reason: z.string().optional(),
      inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(), host: Host,
    }),
    jsonSchema: obj({
      taskId: str("From smr_task_start"), model: str("Model id or host alias (e.g. sonnet)"), passed: { type: "boolean" },
      reason: str("Why it failed"), inputTokens: { type: "integer" }, outputTokens: { type: "integer" },
      host: { type: "string", enum: ["claude-code", "opencode", "codex", "generic"] },
    }, ["taskId", "model", "passed"]),
    async run(ctx, i) {
      const r = session(ctx, i.host).recordAttempt(i.taskId, { model: i.model, passed: i.passed, failureReason: i.reason, inputTokens: i.inputTokens, outputTokens: i.outputTokens });
      return { attemptId: r.attempt.id, next: r.next };
    },
  }),
  op({
    name: "smr_task_next",
    description: "What to do next for a task, based on its real attempt history.",
    input: z.object({ taskId: z.string(), host: Host }),
    jsonSchema: obj({ taskId: str("Task id"), host: { type: "string", enum: ["claude-code", "opencode", "codex", "generic"] } }, ["taskId"]),
    run: async (ctx, i) => session(ctx, i.host).next(i.taskId),
  }),
  op({
    name: "smr_task_handoff",
    description: "Compact handoff (requirement, constraints, failure history) to give the next model instead of the whole conversation. Secrets are redacted.",
    input: z.object({ taskId: z.string(), constraints: z.array(z.string()).optional(), files: z.array(z.string()).optional() }),
    jsonSchema: obj({ taskId: str("Task id"), constraints: { type: "array", items: { type: "string" } }, files: { type: "array", items: { type: "string" } } }, ["taskId"]),
    run: async (ctx, i) => ({ handoff: session(ctx).handoff(i.taskId, { constraints: i.constraints, relevantFiles: i.files }) }),
  }),
  op({
    name: "smr_verify",
    description: "Run the checks this task needs (typecheck/lint/build, then tests) in the project. With taskId+model it records the attempt and returns the next action.",
    input: z.object({ taskId: z.string().optional(), task: z.string().optional(), model: z.string().optional(), host: Host }),
    jsonSchema: obj({ taskId: str("Task id"), task: str("Task text if no taskId"), model: str("Model that did the work"), host: { type: "string", enum: ["claude-code", "opencode", "codex", "generic"] } }),
    async run(ctx, i) {
      const rec = i.taskId ? ctx.store().getTask(i.taskId) : undefined;
      if (i.taskId && !rec) throw new Error(`unknown task id: ${i.taskId}`);
      if (!rec && !i.task) throw new Error("taskId or task is required");
      const c = rec?.task.classification ?? classifyTask(i.task!);
      const result = await evaluate(c, { cwd: ctx.cwd, checks: ctx.cfg.checks ?? detectChecks(ctx.cwd) });
      const next = rec && i.model
        ? session(ctx, i.host).recordAttempt(rec.task.id, { model: i.model, passed: result.passed, failureReason: result.failureSummary?.slice(0, 500) }).next
        : undefined;
      return { ...result, next };
    },
  }),
  op({
    name: "smr_execute",
    description: "Execute a non-agentic task (docs, plans, explanations, snippets) directly via the routed provider, with automatic verification, escalation and usage logging.",
    input: z.object({ task: z.string().min(1), system: z.string().optional() }),
    jsonSchema: obj({ task: str("The task"), system: str("Optional system prompt") }, ["task"]),
    async run(ctx, i) {
      return executeTask(i.task, await classify(ctx, i.task), {
        store: ctx.store(), providers: ctx.providers, registry: ctx.registry,
        policy: policyFor(ctx.cfg), router: ctx.routing(), system: i.system,
      });
    },
  }),
  op({
    name: "smr_models",
    description: "List models in the registry with tier, relative cost and capability scores.",
    input: z.object({}).passthrough(),
    jsonSchema: obj({}),
    run: async (ctx) => ctx.registry.all().map((m) => ({ id: m.id, tier: m.tier, available: m.available, relativeCost: m.relativeCost, pricing: m.pricing, scores: m.scores, scoreSource: m.scoreSource, hostAliases: m.hostAliases })),
  }),
  op({
    name: "smr_report",
    description: "Usage report: per-model attempts, pass rate, tokens and cost; pass rate by category; recent tasks.",
    input: z.object({ limit: z.number().int().positive().max(200).optional() }),
    jsonSchema: obj({ limit: { type: "integer" } }),
    async run(ctx, i) {
      const s = ctx.store();
      return {
        backend: s.backend,
        models: s.modelStats(),
        categories: s.categoryStats(),
        recentTasks: s.listTasks(i.limit ?? 10).map((t) => ({ id: t.id, status: t.status, category: t.category, routedTo: t.decision.selectedModel, text: t.text.slice(0, 120), createdAt: t.createdAt })),
      };
    },
  }),
  op({
    name: "smr_pack_context",
    description: "Token optimizer: pick only the files relevant to a task, dedupe, compress, and pack them under a token budget (big files reduced to the relevant parts). Sensitive files (.env, keys) are never included.",
    input: z.object({ task: z.string().min(1), dirs: z.array(z.string()).optional(), files: z.array(z.string()).optional(), budgetTokens: z.number().int().positive().max(200_000).optional() }),
    jsonSchema: obj({ task: str("The task"), dirs: { type: "array", items: { type: "string" }, description: "Folders to scan (relative to the project)" }, files: { type: "array", items: { type: "string" } }, budgetTokens: { type: "integer" } }, ["task"]),
    async run(ctx, i) {
      const files: ContextFile[] = [];
      const inside = (p: string) => { const full = resolve(ctx.cwd, p); if (!full.startsWith(resolve(ctx.cwd))) throw new Error(`path outside project: ${p}`); return full; };
      for (const d of i.dirs ?? ["."]) files.push(...collectFiles(inside(d)).map((f) => ({ ...f, path: d === "." ? f.path : `${d.replace(/\/$/, "")}/${f.path}` })));
      for (const f of i.files ?? []) { const full = inside(f); if (existsSync(full)) files.push({ path: f, content: readFileSync(full, "utf8") }); }
      const r = packContext(i.task, files, i.budgetTokens ?? ctx.cfg.optimizer?.contextBudgetTokens ?? 8_000);
      return { markdown: r.markdown, files: r.files.map(({ content, ...f }) => f), dropped: r.dropped, tokensBefore: r.tokensBefore, tokensAfter: r.tokensAfter, savedPct: r.savedPct };
    },
  }),
  op({
    name: "smr_learn",
    description: "Learning Engine view: per model × task type, the registry prior, the observed pass rate and the blended probability the router now uses.",
    input: z.object({}).passthrough(),
    jsonSchema: obj({}),
    run: async (ctx) => learningReport(ctx.store(), ctx.registry, ctx.cfg.learning),
  }),
] as const satisfies readonly Operation[];

export function findOperation(name: string): Operation | undefined {
  return (OPERATIONS as readonly Operation[]).find((o) => o.name === name);
}

export async function runOperation(ctx: ApiContext, name: string, rawInput: unknown): Promise<unknown> {
  const o = findOperation(name);
  if (!o) throw new ApiError(404, `unknown operation: ${name}`);
  const parsed = o.input.safeParse(rawInput ?? {});
  if (!parsed.success) throw new ApiError(400, parsed.error.issues.map((x) => `${x.path.join(".") || "input"}: ${x.message}`).join("; "));
  return o.run(ctx, parsed.data);
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
