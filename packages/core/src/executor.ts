import { ModelRegistry } from "./registry.js";
import { ProviderError, ProviderRegistry } from "./providers.js";
import { TaskSession } from "./session.js";
import { suggestMaxTokens } from "./optimizer.js";
import type { ExecutionStore, TaskStatus } from "./store.js";
import type { EscalationPolicy, HostId, RouterOptions, TaskClassification } from "./types.js";

/**
 * Direct Executor — for custom agents and hosts that can't switch models themselves.
 *
 *   route → call provider → log real usage → verify → retry / escalate → result
 *
 * Every attempt (tokens, cost, pass/fail) goes into the execution log automatically.
 */

export interface Verifier {
  (output: string, ctx: { taskId: string; modelId: string; attempt: number }): Promise<{ passed: boolean; reason?: string }>;
}

/** Default: non-empty answer that doesn't hand the task back. Plug in real checks for code. */
export const defaultVerifier: Verifier = async (output) => {
  if (!output.trim()) return { passed: false, reason: "empty response" };
  const esc = output.match(/^\s*ESCALATE:\s*(.*)/i);
  if (esc) return { passed: false, reason: `model was unable to complete: ${esc[1]?.slice(0, 200) ?? ""}` };
  return { passed: true };
};

export interface ExecuteEvent {
  type: "attempt" | "result" | "error";
  modelId: string;
  passed?: boolean;
  reason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ExecuteResult {
  taskId: string;
  status: TaskStatus;
  output?: string;
  finalModel?: string;
  attempts: number;
  reason: string;
}

const SYSTEM = [
  "You are a focused worker inside a Smart Model Router.",
  "Do exactly the task. Be concise. Keep every stated constraint.",
  "If the task is beyond what you can do reliably, reply with a single line: ESCALATE: <reason>.",
].join(" ");

export async function executeTask(
  text: string,
  classification: TaskClassification,
  opts: {
    store: ExecutionStore;
    providers: ProviderRegistry;
    registry?: ModelRegistry;
    policy?: EscalationPolicy;
    host?: HostId;
    router?: RouterOptions;
    system?: string;
    maxTokens?: number;
    verifier?: Verifier;
    onEvent?: (e: ExecuteEvent) => void;
  },
): Promise<ExecuteResult> {
  const registry = opts.registry ?? new ModelRegistry();
  const session = new TaskSession(opts.store, registry, opts.policy, opts.host ?? "generic", opts.router);
  const verify = opts.verifier ?? defaultVerifier;
  const task = session.start(text, classification);
  let next = session.next(task.id);
  let attempts = 0;
  let lastOutput: string | undefined;

  for (let guard = 0; guard < 12 && (next.action === "retry" || next.action === "escalate"); guard++) {
    const modelId = next.modelId!;
    const prompt = attempts === 0
      ? text
      : `${session.handoff(task.id)}\n\nComplete the task above. Your previous attempt's output was rejected; fix the listed problems.`;
    attempts++;
    const t0 = Date.now();
    try {
      const r = await opts.providers.complete(modelId, {
        prompt,
        system: opts.system ?? SYSTEM,
        cacheSystem: true,
        maxTokens: opts.maxTokens ?? suggestMaxTokens(classification, opts.router?.history?.lookup(modelId, classification.category, classification.complexity)),
      });
      lastOutput = r.text;
      const v = await verify(r.text, { taskId: task.id, modelId, attempt: attempts });
      opts.onEvent?.({ type: "attempt", modelId, passed: v.passed, reason: v.reason, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens });
      next = session.recordAttempt(task.id, {
        model: modelId, passed: v.passed, failureReason: v.reason,
        inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, durationMs: Date.now() - t0,
      }).next;
    } catch (e) {
      // Provider down / no key / rate-limited: retrying the same model is pointless → "unable to" escalates.
      const msg = e instanceof ProviderError ? e.message : (e as Error).message;
      opts.onEvent?.({ type: "error", modelId, reason: msg });
      next = session.recordAttempt(task.id, { model: modelId, passed: false, failureReason: `unable to reach provider: ${msg}`, durationMs: Date.now() - t0 }).next;
    }
  }

  const rec = opts.store.getTask(task.id)!;
  const passed = rec.attempts.find((a) => a.passed);
  if (next.action !== "complete" && rec.task.status === "open") opts.store.setStatus(task.id, "failed");
  const status = opts.store.getTask(task.id)!.task.status;
  opts.onEvent?.({ type: "result", modelId: passed?.modelId ?? "", passed: !!passed, reason: next.reason });
  return {
    taskId: task.id,
    status,
    output: passed ? lastOutput : undefined,
    finalModel: passed?.modelId,
    attempts,
    reason: next.reason,
  };
}
