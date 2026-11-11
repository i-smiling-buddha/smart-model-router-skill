import { readFileSync } from "node:fs";
import { RegistrySchema, type ModelSpec, type Registry, type HostId } from "./types.js";

/**
 * Default registry — Anthropic models only, so the Claude Code integration works out of the box.
 *
 * IMPORTANT: all `scores` are INITIAL ESTIMATES (scoreSource: "initial-estimate").
 * `pricing` is intentionally null — fill it in from the provider's current pricing page.
 * Until then routing uses `relativeCost`, which is enough to compare models.
 */
export const DEFAULT_REGISTRY: Registry = RegistrySchema.parse({
  version: 1,
  models: [
    {
      id: "anthropic/claude-haiku-5-5",
      provider: "anthropic",
      displayName: "Claude Haiku 5.5",
      tier: "budget",
      hostAliases: { "claude-code": "haiku", opencode: "anthropic/claude-haiku-5-5", codex: "smr-fast" },
      scores: { coding: 70, reasoning: 62, debugging: 60, creative: 62, instructionFollowing: 80, speed: 95 },
      relativeCost: 1,
      capabilities: { toolCalling: true, vision: true },
    },
    {
      id: "anthropic/claude-sonnet-5-5",
      provider: "anthropic",
      displayName: "Claude Sonnet 5.5",
      tier: "standard",
      hostAliases: { "claude-code": "sonnet", opencode: "anthropic/claude-sonnet-5-5", codex: "smr-builder" },
      scores: { coding: 88, reasoning: 82, debugging: 84, creative: 80, instructionFollowing: 90, speed: 75 },
      relativeCost: 3,
      capabilities: { toolCalling: true, vision: true },
    },
    {
      id: "anthropic/claude-opus-5-5",
      provider: "anthropic",
      displayName: "Claude Opus 5.5",
      tier: "premium",
      hostAliases: { "claude-code": "opus", opencode: "anthropic/claude-opus-5-5", codex: "smr-architect" },
      scores: { coding: 94, reasoning: 93, debugging: 93, creative: 88, instructionFollowing: 93, speed: 55 },
      relativeCost: 5,
      capabilities: { toolCalling: true, vision: true },
    },
    {
      id: "anthropic/claude-fable-5-2",
      provider: "anthropic",
      displayName: "Claude Fable 5.2",
      tier: "frontier",
      hostAliases: { "claude-code": "claude-fable-5-2", opencode: "anthropic/claude-fable-5-2", codex: "smr-architect" },
      scores: { coding: 97, reasoning: 97, debugging: 96, creative: 92, instructionFollowing: 94, speed: 40 },
      relativeCost: 10,
      capabilities: { toolCalling: true, vision: true },
      available: false,
      notes: "Disabled by default. Set available: true if your plan/API key has access.",
    },
  ],
});

const TIER_RANK: Record<ModelSpec["tier"], number> = { budget: 0, standard: 1, premium: 2, frontier: 3 };
export const tierRank = (m: ModelSpec): number => TIER_RANK[m.tier];

export class ModelRegistry {
  private readonly byId = new Map<string, ModelSpec>();

  constructor(registry: Registry = DEFAULT_REGISTRY) {
    const parsed = RegistrySchema.parse(registry);
    for (const m of parsed.models) {
      if (this.byId.has(m.id)) throw new Error(`Duplicate model id in registry: ${m.id}`);
      this.byId.set(m.id, m);
    }
  }

  /** Load a registry JSON file. With `merge: true` entries override/extend the defaults by id. */
  static fromFile(path: string, opts: { merge?: boolean } = {}): ModelRegistry {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const user = RegistrySchema.parse(raw);
    if (!opts.merge) return new ModelRegistry(user);
    const merged = new Map(DEFAULT_REGISTRY.models.map((m) => [m.id, m]));
    for (const m of user.models) merged.set(m.id, m);
    return new ModelRegistry({ version: user.version, models: [...merged.values()] });
  }

  all(): ModelSpec[] {
    return [...this.byId.values()];
  }

  available(): ModelSpec[] {
    return this.all().filter((m) => m.available);
  }

  get(id: string): ModelSpec | undefined {
    return (
      this.byId.get(id) ??
      this.all().find((m) => Object.values(m.hostAliases).includes(id)) ??
      // bare provider model name, e.g. "claude-sonnet-5-5" from a transcript
      this.all().find((m) => m.id.endsWith("/" + id))
    );
  }

  require(id: string): ModelSpec {
    const m = this.get(id);
    if (!m) throw new Error(`Unknown model: ${id}. Run "smr models" to see the registry.`);
    return m;
  }

  hostModel(m: ModelSpec, host: HostId = "generic"): string {
    return m.hostAliases[host] ?? m.id;
  }
}
