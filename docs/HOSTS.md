# Using SMR with your assistant

All hosts share the same engine and the same task lifecycle:

```text
start (route)  →  delegate to the routed agent  →  verify  →  follow next.action
                                                           retry · escalate · stop · complete
```

## Claude Code

```bash
smr init claude-code
```

Installs:

| File | Purpose |
|---|---|
| `.claude/skills/smart-model-router/SKILL.md` | The orchestration procedure |
| `.claude/agents/smr-fast.md` | `model: haiku` — exploration, docs, typos, small fixes |
| `.claude/agents/smr-builder.md` | `model: sonnet` — features, bugs, refactors, tests, review |
| `.claude/agents/smr-architect.md` | `model: opus` — architecture, hard debugging, security/payments, escalations |
| `.claude/settings.json` | `SubagentStop` hook → `smr hook subagent-stop` records each subagent's tokens |
| `.mcp.json` | `smr` MCP server (optional; the skill also works with the CLI) |
| `smr.config.json` | Mode, limits, learning, checks |

Use Claude Code normally, or say "use SMR". Keeping the main session on Sonnet keeps orchestration
cheap; the heavy lifting happens in the routed subagent.

If you already had `.claude/settings.json` or `.mcp.json`, `smr init` leaves them alone — merge the
`SubagentStop` hook and the `smr` server entry by hand, then run `smr doctor`.

## OpenCode

```bash
smr init opencode
```

Installs `.opencode/agents/smr-router.md` (primary agent) and three subagents, plus the `smr` MCP
server in `opencode.json`. Select **smr-router** as your agent; it delegates with the `subagent` tool.
Subagent models are `anthropic/claude-*-5-5` by default — edit the `model:` lines to use other providers.

## Codex

```bash
smr init codex
```

Installs the skill in `.agents/skills/smart-model-router/`, three custom agents in
`.codex/agents/*.toml` (each with its own `model` and `model_reasoning_effort`), the `smr` MCP
server in `.codex/config.toml`, and an `AGENTS.md` note. Codex does not spawn custom agents on its
own; the skill and `AGENTS.md` tell it to spawn the routed agent explicitly.

> **Check the model names** in `.codex/agents/*.toml` (`gpt-5.4-mini`, `gpt-5.5`) against the
> models your Codex account offers, and edit them if needed.

For Codex, routing returns the **agent role** (`smr-fast` / `smr-builder` / `smr-architect`) as
`hostModel`, so the skill knows which agent to spawn.

## Any MCP host

Add a stdio server that runs `smr mcp` (Windows: `cmd /c smr mcp`). Tools:

| Tool | Purpose |
|---|---|
| `smr_task_start` | Open a logged task, get the routed model |
| `smr_verify` | Run the needed checks, record the attempt, return `next` |
| `smr_task_attempt` · `smr_task_next` · `smr_task_handoff` | Lifecycle |
| `smr_route` · `smr_classify` · `smr_models` | Routing info |
| `smr_execute` | Direct provider execution for non-agentic tasks (spends API credits) |
| `smr_pack_context` | Token-optimized context for a task (paths stay inside the project) |
| `smr_report` · `smr_learn` | Usage and learning views |

## HTTP API

```bash
smr serve --port 4317        # binds 127.0.0.1 only
```

| Endpoint | |
|---|---|
| `GET /health` · `GET /models` · `GET /usage` · `GET /dashboard` | status, registry, report, HTML dashboard |
| `POST /tasks/classify` · `POST /tasks/route` | |
| `POST /tasks` · `POST /tasks/:id/attempts` · `GET /tasks/:id/next` · `POST /tasks/:id/handoff` · `GET /tasks/:id` | lifecycle |
| `POST /tasks/evaluate` · `POST /tasks/execute` | verify · direct execution |

POST bodies must be `application/json`. Set `SMR_API_TOKEN` to require
`Authorization: Bearer <token>` on everything except `/health`. Requests from other websites
(cross-origin or DNS-rebinding) are refused — see [SECURITY.md](../SECURITY.md).

## Direct execution

```bash
smr exec "write a README section explaining the config file"
```

For tasks that don't need file edits, or custom agents that can't switch models: SMR calls the
provider itself, verifies the answer, escalates if needed, and logs real token usage.
