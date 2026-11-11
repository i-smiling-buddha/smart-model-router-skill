# SMR Roadmap

## ✅ Phase 1 — Foundation (MVP) — done
- [x] TypeScript monorepo (npm workspaces)
- [x] Model Registry (zod schema, merge-able user registry, host aliases)
- [x] Task Classifier (rule-based, English + हिंदी + Hinglish, complexity 1–4, risk, confidence)
- [x] Intelligent Router (weighted scoring, smart/economy/quality modes, critical-task floor)
- [x] Cost estimator (USD when pricing set, relative units otherwise) + expected cost per success
- [x] Escalation manager (retry → escalate → stop, cost ceiling)
- [x] Context handoff builder (constraints never dropped, sensitive files excluded, secrets redacted)
- [x] CLI: route / classify / escalate / models / init
- [x] Claude Code integration (skill + haiku/sonnet/opus subagents)
- [x] OpenCode integration (primary router agent + subagents)
- [x] Test suite

## ✅ Phase 2 — Intelligence — done
- [x] LLM fallback classification when `confidence < 0.6` (cheap model, cached, never lowers risk)
- [x] Quality Evaluator: static → functional (fail-fast) → semantic checklist; auto-detects package.json checks
- [x] Execution log: `node:sqlite` with JSON fallback — tasks, attempts, tokens, cost, cache
- [x] Retry management from real history: `smr task start / attempt / next / handoff / show`
- [x] `smr verify <id> --model <m>` records the attempt and returns the next action
- [x] `smr report` — per-model pass rate, tokens, cost; pass rate by category
- [x] Claude Code skill + OpenCode router updated to the logged lifecycle

## ✅ Phase 2b — done
- [x] Claude Code SubagentStop hook → token usage parsed from subagent transcript, attached to the next attempt

## ✅ Phase 3 — Universal Integration — done
- [x] Codex adapter: `.agents/skills` skill, `.codex/agents/*.toml` (per-agent model), MCP in `.codex/config.toml`, `AGENTS.md`
- [x] Common SMR API (one set of operations) exposed as:
  - [x] MCP stdio server — `smr mcp` (10 tools) — works with any MCP host
  - [x] Local HTTP API — `smr serve` (127.0.0.1, optional bearer token). Built on `node:http` instead of Fastify: zero extra dependencies.
- [x] Provider adapters: Anthropic, OpenAI, OpenRouter, Google Gemini, Ollama (+ any OpenAI-compatible endpoint)
- [x] Direct executor `smr exec` with automatic usage logging, ESCALATE handling, provider-outage escalation
- [x] MCP configs for Claude Code (`.mcp.json`) and OpenCode (`opencode.json`)
- [x] `smr init` never overwrites existing files; reports what it skipped
- [x] Decisions remember their host across the task lifecycle

## Carry-over
- [ ] Live tests against real provider APIs (LLM classifier + `smr exec`)
- [ ] Verify Codex agent model names against current Codex models
- [ ] Automatic token capture for OpenCode / Codex (plugin / hook equivalents)

## Phase 4 — Optimization
- [ ] Benchmark suite: single model vs SMR vs best model (success rate, cost, retries)
- [ ] Replace initial-estimate scores with benchmark + observed scores
- [ ] Adaptive ranking from history (statistical first, contextual bandit later)
- [ ] Dashboard

## Phase 5 — Release
- [ ] Windows installer, docs, security audit, open-source release
