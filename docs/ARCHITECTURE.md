# Architecture

```text
 you / your assistant
        │  task in natural language
        ▼
 ┌──────────── Integration layer ───────────────────────────────────────────┐
 │ Claude Code skill+subagents+hook │ OpenCode agents │ Codex skill+agents   │
 │ MCP server (smr mcp)             │ HTTP API (smr serve) │ CLI │ smr exec  │
 └──────────────────────────┬───────────────────────────────────────────────┘
                            │  Common SMR API (packages/server/src/api.ts)
 ┌──────────────────────────▼──────────── SMR Core Engine (packages/core) ──┐
 │ classifier → router ← registry      learning (history)                    │
 │      │          │                        ▲                                │
 │      ▼          ▼                        │                                │
 │   session ── escalation ── handoff ── store (SQLite / JSON log)           │
 │      │                                   ▲                                │
 │   evaluator (static → functional → semantic)                             │
 │   optimizer (context packing, output caps)   benchmark   dashboard        │
 │   providers (Anthropic · OpenAI · OpenRouter · Gemini · Ollama) ← executor│
 └───────────────────────────────────────────────────────────────────────────┘
```

## Packages

| Path | |
|---|---|
| `packages/core` | The engine. No network or filesystem side effects except the store, evaluator commands and provider calls you ask for. |
| `packages/server` | One list of operations (`OPERATIONS`) served over MCP stdio and HTTP. |
| `apps/cli` | The `smr` command. |
| `integrations/*` | Host templates copied by `smr init`. |
| `benchmarks/suites` | Benchmark suites. |
| `scripts/` | Release bundling (esbuild), installers, smoke test. |

The release is a single bundled file (`dist/smr.mjs`) plus templates — no runtime dependencies.

## Task lifecycle

1. **Classify** (`classifier.ts`) — rule-based, English + Devanagari + Hinglish keywords →
   category, complexity 1–4, risk, confidence. Optional: low confidence → a cheap LLM refines it
   (`llm-classifier.ts`); it can never lower the risk the rules found.
2. **Route** (`router.ts`) — for every model:
   - `S_raw` = category-weighted capability (e.g. development = 0.6·coding + 0.25·reasoning + 0.15·debugging)
   - demand = by complexity (50 / 65 / 78 / 84) + category offset + risk
   - prior p(success) = sigmoid((S_raw − demand) / 5), then **blended with history**:
     `p = (p_prior·k + passes) / (k + attempts)`
   - `Q` = clamp(100 − 2.5·max(0, demand + 10 − S_raw)) · `S` = Q minus an overkill penalty ·
     `R` = 100·p · `C` = cheapest expected cost-per-success ÷ this model's · `L` = speed
   - score = 0.35Q + 0.25S + 0.20R + 0.10C + 0.10L (smart; economy/quality shift weights)
   - hard rules: availability, vision, tool calling, context window, cost ceiling, reliability floor
     (0.6, or 0.8 for critical tasks) — if nobody clears the floor, the strongest model is chosen with a warning.
3. **Delegate** with a compact handoff (`handoff.ts`) — constraints and user decisions are never
   trimmed; sensitive files are excluded; secrets are redacted.
4. **Verify** (`evaluator.ts`) — only the levels the task needs; static failures skip tests.
5. **Decide next** (`escalation.ts` + `session.ts`) from the logged history: retry once →
   escalate one tier → stop after the limits. "Unable to" failures (context window, provider
   down, `ESCALATE:` answers) skip the pointless retry.
6. **Log** (`store.ts`) — tasks, attempts, tokens, cost. Feeds learning, reports, benchmarks import
   and the dashboard.

## Why cost-per-success

A model at 1× price with a 40% success rate costs 2.5× per success; a 3× model at 99% costs ~3×.
The router compares `cost / p(success)`, so cheap-but-unreliable models only win tasks they can
actually do — and learning keeps p(success) honest over time.
