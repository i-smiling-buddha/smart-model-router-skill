# Security

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting:
*Security → Report a vulnerability* on
[the repository](https://github.com/i-smiling-buddha/smart-model-router-skill/security/advisories/new).
Include steps to reproduce and the SMR version (`smr --version`).

## Threat model

SMR runs on your machine, inside your projects, next to your API keys. It is designed so that:

| Asset | Protection |
|---|---|
| **API keys** | Read from environment variables only. Never written to the log, config, prompts, handoffs, error messages or the dashboard. `smr doctor` reports only *whether* a key is set. |
| **Secrets in your project** | `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `secrets.*` are never included in handoffs or packed context. Common key formats (Anthropic, OpenAI-style, GitHub, AWS, Google, private-key blocks, `api_key=…`) are redacted from handoffs, context, task text and failure reasons before anything is stored or sent. |
| **Your code** | Local-first: the log lives in `<project>/.smr/` (owner-only permissions on macOS/Linux). Nothing is uploaded except what you send to a model provider yourself (`smr exec`, `smr bench`, `--llm`). |
| **Your money** | Retry, escalation and optional cost-ceiling limits stop runaway tasks. |
| **Your machine** | Verification only runs commands from your `package.json` scripts or your `smr.config.json` — never commands chosen by a model. |

## Local HTTP API (`smr serve`)

- Binds to `127.0.0.1` only.
- **Cross-site protection:** a website open in your browser can send requests to localhost. SMR
  refuses requests whose `Host` isn't a loopback name (DNS rebinding), whose `Origin` isn't local,
  and POST bodies that aren't `application/json` (which forces a CORS preflight SMR never approves).
  Without this, a malicious page could have triggered `POST /tasks/execute` and spent API credits.
- Optional bearer token (`SMR_API_TOKEN`, constant-time comparison) for everything except `/health`.
- 1 MB request body limit; `nosniff`, `no-store` headers; the dashboard is served with a strict CSP.

## MCP server (`smr mcp`)

- stdio only; no network listener.
- `smr_pack_context` refuses paths outside the project folder.
- `smr_execute` calls paid APIs — your MCP host's tool-approval prompt applies to it.

## Benchmarks run model-written code

`node-test` cases execute the code a model wrote (in a temporary folder, with a timeout, as your
user). SMR refuses to run a suite with such cases unless you pass `--allow-code-exec`. Only run
suites you trust; consider a container or VM for untrusted ones.

## Hooks

`smr hook subagent-stop` only reads the transcript path Claude Code passes to it, extracts token
counts, and always exits 0 so it can never block or break your session.

## Supply chain

- Runtime: the release is a single bundled file; its only third-party code is `zod`.
- `npm audit` runs in CI (fails on high/critical). At the 1.0.0-rc.1 audit: **0 vulnerabilities**
  in production and dev dependencies.

## Audit log — 1.0.0-rc.1

| Finding | Severity | Fix |
|---|---|---|
| Local HTTP API reachable from web pages (simple-request CSRF, DNS rebinding) → could spend API credits / run checks | High | Host + Origin checks, JSON-only POSTs, tests |
| `zod` < 4.6.6 memory exhaustion advisory (GHSA-mrhx-c7xc-m3w5) | High | Upgraded to zod 4.6.7 |
| Dev tooling advisories (vitest/tinypool/esbuild) | Critical (dev only) | Upgraded to vitest 5, esbuild 0.28 |
| Secrets typed into task text / failure reasons stored unredacted in `.smr/` | Medium | Redaction at the store layer, tests |
| Benchmarks executed model-written code without explicit consent | Medium | `--allow-code-exec` opt-in |
| `.smr/` created with default permissions | Low | Owner-only mode on POSIX |
| Windows MCP configs launched `smr` without a shell (fails on `.cmd` shim) | Compatibility | `cmd /c` written by `smr init` on Windows; `smr doctor` check |
