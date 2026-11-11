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

## Phase 2 — Intelligence (next)
- [ ] LLM fallback classification when `confidence < 0.6` (cheapest model, cached)
- [ ] Quality Evaluator module: run static/functional checks from config (`tsc`, `eslint`, `npm test`)
- [ ] Execution log (SQLite): task → model → attempts → pass/fail → tokens
- [ ] `smr report` — per-session cost and routing summary
- [ ] Claude Code hooks: capture subagent results automatically into the log

## Phase 3 — Universal Integration
- [ ] Codex adapter (skills)
- [ ] Generic adapter: local HTTP API (Fastify) + MCP server
- [ ] Provider adapters (Anthropic / OpenAI / Google / OpenRouter / Ollama) for direct execution

## Phase 4 — Optimization
- [ ] Benchmark suite: single model vs SMR vs best model (success rate, cost, retries)
- [ ] Replace initial-estimate scores with benchmark + observed scores
- [ ] Adaptive ranking from history (statistical first, contextual bandit later)
- [ ] Dashboard

## Phase 5 — Release
- [ ] Windows installer, docs, security audit, open-source release
