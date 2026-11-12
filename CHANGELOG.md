# Changelog

All notable changes. Format: [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [1.0.0-rc.1] — 2026-11-12

First release candidate. Phase 5 (Release).

### Added
- Single-file release bundle (`dist/smr.mjs`) and npm package `smart-model-router-skill` (`smr` command).
- Installers: `scripts/install.ps1` (Windows) and `scripts/install.sh` (macOS/Linux).
- `smr doctor` — checks Node, SQLite, PATH, config, registry, keys (names only), log folder and installed integrations (incl. Windows MCP launchers).
- `smr --version`; `smr init --platform windows|posix`; Windows-safe MCP configs (`cmd /c smr mcp`).
- CI on Windows, macOS and Linux (Node 22/24 tests, Node 20 runtime smoke tests, Windows installer job) and a tag-triggered release workflow.
- Compatibility tests for every host template and end-to-end CLI tests (also run against the release bundle).
- Docs: English README, Hindi guide, install, hosts, configuration, architecture, benchmarks, security.

### Security
- Local HTTP API refuses cross-origin, DNS-rebinding and non-JSON POST requests.
- Secrets are redacted from task text and failure reasons before they are logged.
- Benchmarks require `--allow-code-exec` before running model-written code.
- `.smr/` is created owner-only on POSIX.
- Dependencies upgraded (zod 4.6.7, vitest 5, esbuild 0.28): 0 known vulnerabilities.

### Fixed
- "Fix the typos …" was classified as debugging; now documentation.
- Benchmark comparison text when success is equal but cost is higher.

## [0.4.0] — Phase 4: Optimization
Benchmark engine (smr vs single vs best, verifiers incl. node-test, simulation, import), Learning
Engine (Bayesian blend of prior and observed results), token optimizer (`smr context`, output caps,
Anthropic prompt caching), HTML dashboard, MCP tools `smr_pack_context` and `smr_learn`.

## [0.3.0] — Phase 3: Universal integration
MCP stdio server and local HTTP API over one Common API; provider adapters (Anthropic, OpenAI,
OpenRouter, Gemini, Ollama); `smr exec`; Codex adapter; Claude Code SubagentStop hook for automatic
token capture; decisions remember their host.

## [0.2.0] — Phase 2: Intelligence
Quality Evaluator, execution log (SQLite/JSON), history-based retry and escalation (`smr task …`,
`smr verify`), LLM fallback classifier, `smr report`.

## [0.1.0] — Phase 1: MVP
Task classifier, model registry, weighted router, cost estimator, escalation, compact handoff, CLI,
Claude Code and OpenCode integrations.
