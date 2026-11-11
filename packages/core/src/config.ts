import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CheckCommand } from "./evaluator.js";
import { DEFAULT_POLICY } from "./escalation.js";
import { ModelRegistry } from "./registry.js";
import type { EscalationPolicy, HostId, RouterOptions, RoutingMode } from "./types.js";

export interface SmrConfig {
  mode?: RoutingMode;
  host?: HostId;
  approval?: "auto" | "confirm" | "recommend";
  registryPath?: string;
  storeDir?: string;
  maxRetriesPerModel?: number;
  maxEscalations?: number;
  costCeilingUsd?: number;
  minSuccessProbability?: number;
  checks?: CheckCommand[];
  llmClassifier?: { enabled?: boolean; model?: string; threshold?: number };
  server?: { port?: number };
}

export function loadConfig(path = "smr.config.json"): SmrConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SmrConfig;
  } catch (e) {
    throw new Error(`Invalid ${path}: ${(e as Error).message}`);
  }
}

export function registryFor(cfg: SmrConfig, override?: string): ModelRegistry {
  const p = override ?? cfg.registryPath;
  return p ? ModelRegistry.fromFile(p, { merge: true }) : new ModelRegistry();
}

export function policyFor(cfg: SmrConfig): EscalationPolicy {
  return {
    maxRetriesPerModel: cfg.maxRetriesPerModel ?? DEFAULT_POLICY.maxRetriesPerModel,
    maxEscalations: cfg.maxEscalations ?? DEFAULT_POLICY.maxEscalations,
    costCeilingUsd: cfg.costCeilingUsd,
  };
}

export function routerOptsFor(cfg: SmrConfig, overrides: { mode?: RoutingMode; host?: HostId } = {}): RouterOptions & { host: HostId } {
  return {
    mode: overrides.mode ?? cfg.mode ?? "smart",
    host: overrides.host ?? cfg.host ?? "generic",
    costCeilingUsd: cfg.costCeilingUsd,
    minSuccessProbability: cfg.minSuccessProbability,
  };
}

export const storeDirFor = (cfg: SmrConfig) => resolve(cfg.storeDir ?? ".smr");
