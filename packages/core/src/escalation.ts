import { ModelRegistry, tierRank } from "./registry.js";
import { Router, successProbability } from "./router.js";
import type {
  AttemptRecord,
  EscalationDecision,
  EscalationPolicy,
  HostId,
  RouterOptions,
  TaskClassification,
} from "./types.js";

export const DEFAULT_POLICY: EscalationPolicy = { maxRetriesPerModel: 2, maxEscalations: 2 };

/**
 * Fallback & Escalation Manager.
 *
 * Given the attempt history for a task, decide: complete / retry same model / escalate / stop.
 * Hard limits (retries, escalations, cost ceiling) prevent a bad task from bouncing forever.
 */
export function decideNext(
  task: TaskClassification,
  attempts: AttemptRecord[],
  registry: ModelRegistry = new ModelRegistry(),
  policy: EscalationPolicy = DEFAULT_POLICY,
  opts: { host?: HostId; router?: RouterOptions } = {},
): EscalationDecision {
  const host = opts.host ?? "generic";
  if (attempts.length === 0) {
    const d = new Router(registry).route(task, { ...opts.router, host });
    return { action: "retry", modelId: d.selectedModel, hostModel: d.hostModel, reason: "first attempt: " + d.routingReason };
  }

  const last = attempts[attempts.length - 1]!;
  if (last.passed) return { action: "complete", modelId: last.modelId, reason: "verification passed" };

  const spent = attempts.reduce((s, a) => s + (a.costUsd ?? 0), 0);
  if (policy.costCeilingUsd !== undefined && spent >= policy.costCeilingUsd) {
    return { action: "stop", reason: `cost ceiling reached ($${spent.toFixed(4)} ≥ $${policy.costCeilingUsd}). Ask the user before spending more.` };
  }

  const current = registry.require(last.modelId);
  const triesOnCurrent = countTrailing(attempts, last.modelId);
  if (triesOnCurrent < policy.maxRetriesPerModel && !isCapabilityFailure(last.failureReason)) {
    return {
      action: "retry",
      modelId: current.id,
      hostModel: registry.hostModel(current, host),
      reason: `attempt ${triesOnCurrent}/${policy.maxRetriesPerModel} failed (${last.failureReason ?? "verification failed"}) — retry once with the failure details`,
    };
  }

  const modelsUsed = [...new Set(attempts.map((a) => a.modelId))];
  if (modelsUsed.length - 1 >= policy.maxEscalations) {
    return { action: "stop", reason: `escalation limit (${policy.maxEscalations}) reached. Report what failed and ask the user.` };
  }

  const pCurrent = successProbability(current, task);
  const next = registry
    .available()
    .filter((m) => !modelsUsed.includes(m.id))
    .filter((m) => tierRank(m) > tierRank(current) || successProbability(m, task) > pCurrent + 0.05)
    .sort((a, b) => tierRank(a) - tierRank(b) || successProbability(b, task) - successProbability(a, task))[0];

  if (!next) return { action: "stop", reason: "no stronger model available. Report the failure and ask the user." };
  return {
    action: "escalate",
    modelId: next.id,
    hostModel: registry.hostModel(next, host),
    reason: `${current.displayName} failed ${triesOnCurrent}× — escalating to ${next.displayName} with a compact handoff`,
  };
}

function countTrailing(attempts: AttemptRecord[], modelId: string): number {
  let n = 0;
  for (let i = attempts.length - 1; i >= 0 && attempts[i]!.modelId === modelId; i--) n++;
  return n;
}

/** Failures where retrying the same model is pointless. */
function isCapabilityFailure(reason?: string): boolean {
  return !!reason && /context (window|limit|too long)|cannot|unable to|beyond (my|its) capab|out of depth/i.test(reason);
}
