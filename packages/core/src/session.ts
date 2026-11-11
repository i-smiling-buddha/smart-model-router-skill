import { estimateCost } from "./cost.js";
import { decideNext, DEFAULT_POLICY } from "./escalation.js";
import { buildHandoff } from "./handoff.js";
import { ModelRegistry } from "./registry.js";
import { Router } from "./router.js";
import type { AttemptRow, ExecutionStore, TaskRecord } from "./store.js";
import type { EscalationDecision, EscalationPolicy, HostId, RouterOptions, TaskClassification } from "./types.js";

/**
 * Task lifecycle + Retry Management, backed by the execution log.
 *
 *   start(task)            → routed decision, logged
 *   recordAttempt(...)     → logs pass/fail + tokens, returns what to do next
 *   next(taskId)           → retry / escalate / stop / complete, from the REAL history
 */
export class TaskSession {
  constructor(
    private readonly store: ExecutionStore,
    private readonly registry: ModelRegistry = new ModelRegistry(),
    private readonly policy: EscalationPolicy = DEFAULT_POLICY,
    private readonly host: HostId = "generic",
    private readonly routerOpts: RouterOptions = {},
  ) {}

  start(text: string, classification: TaskClassification): TaskRecord {
    const decision = new Router(this.registry).route(classification, { ...this.routerOpts, host: this.host });
    return this.store.createTask(text, classification, decision);
  }

  recordAttempt(
    taskId: string,
    a: { model: string; passed: boolean; failureReason?: string; inputTokens?: number; outputTokens?: number; durationMs?: number },
  ): { attempt: AttemptRow; next: EscalationDecision } {
    const model = this.registry.require(a.model);
    let costUsd: number | undefined;
    let costUnits: number | undefined;
    if (a.inputTokens !== undefined || a.outputTokens !== undefined) {
      const c = estimateCost(model, a.inputTokens ?? 0, a.outputTokens ?? 0);
      costUsd = c.usd ?? undefined;
      costUnits = c.relativeUnits;
    }
    const attempt = this.store.addAttempt({
      taskId, modelId: model.id, passed: a.passed, failureReason: a.failureReason,
      inputTokens: a.inputTokens, outputTokens: a.outputTokens, costUsd, costUnits, durationMs: a.durationMs,
    });
    const next = this.next(taskId);
    if (next.action === "complete") this.store.setStatus(taskId, "completed");
    if (next.action === "stop") this.store.setStatus(taskId, "stopped");
    return { attempt, next };
  }

  next(taskId: string): EscalationDecision {
    const rec = this.require(taskId);
    if (rec.attempts.length === 0) {
      const d = rec.task.decision;
      return { action: "retry", modelId: d.selectedModel, hostModel: d.hostModel, reason: "first attempt: " + d.routingReason };
    }
    return decideNext(
      rec.task.classification,
      rec.attempts.map((x) => ({ modelId: x.modelId, passed: x.passed, failureReason: x.failureReason, costUsd: x.costUsd })),
      this.registry,
      this.policy,
      { host: this.host, router: this.routerOpts },
    );
  }

  /** Compact handoff for the next model, including the real failure history. */
  handoff(taskId: string, extra: { constraints?: string[]; relevantFiles?: string[]; expectedOutput?: string } = {}): string {
    const { task, attempts } = this.require(taskId);
    return buildHandoff({
      task: task.text.split("\n")[0]!.slice(0, 200),
      originalRequirement: task.text,
      constraints: extra.constraints,
      relevantFiles: extra.relevantFiles,
      expectedOutput: extra.expectedOutput ?? task.classification.successCriteria.join("; "),
      failureHistory: attempts.filter((a) => !a.passed).map((a) => ({ modelId: a.modelId, reason: a.failureReason ?? "verification failed" })),
    });
  }

  private require(taskId: string) {
    const rec = this.store.getTask(taskId);
    if (!rec) throw new Error(`Unknown task id: ${taskId}. Start one with: smr task start "<task>"`);
    return rec;
  }
}
