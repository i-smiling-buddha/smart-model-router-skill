---
name: smart-model-router
description: Route each coding task to the cheapest SMR agent that can reliably do it (smr-fast / smr-builder / smr-architect), verify the result, and escalate only on failure. Use for multi-step coding work, or when the user asks to save tokens/credits, route models, or "use SMR". Do not use for a single quick question.
---

# Smart Model Router (SMR) for Codex

**Principle:** use the cheapest model that can reliably complete the task; escalate only when necessary.

You are the orchestrator. Codex does not spawn custom agents on its own — **you must spawn them
explicitly** by name: `smr-fast`, `smr-builder`, `smr-architect` (defined in `.codex/agents/`,
each with its own model).

## Tools
The `smr` MCP server (configured in `.codex/config.toml`) gives you `smr_task_start`,
`smr_verify`, `smr_task_attempt`, `smr_task_next`, `smr_task_handoff`, `smr_route`, `smr_report`.
If the MCP tools are missing, use the CLI with `--json` (`smr task start --host codex --json "..."`).

## Procedure
1. **Route:** `smr_task_start { task, host: "codex" }` → keep `taskId`; `hostModel` is the agent
   to spawn (`smr-fast` | `smr-builder` | `smr-architect`).
   Without SMR tools: docs/typos/exploration → smr-fast; features/bugs/refactors/review → smr-builder;
   architecture, complex/multi-file debugging, auth/payments/security/production data → smr-architect.
   Security, payments, secrets, production data are **never** below smr-architect.
2. **Delegate** with a compact handoff (task, original requirement, constraints that must be kept,
   relevant files, expected output). Never include secrets or `.env` contents.
3. **Verify:** `smr_verify { taskId, model: <hostModel>, host: "codex" }` — runs only the checks the
   task needs and returns `next`. Tick the `semanticChecklist` yourself against the requirement;
   if it fails, `smr_task_attempt { taskId, model, passed: false, reason }`.
4. **Follow `next.action`:** `retry` → same agent once more with the failure output ·
   `escalate` → `smr_task_handoff { taskId, constraints }` and spawn `next.hostModel` ·
   `stop` → explain and ask the user · `complete` → done.
   If an agent replies `ESCALATE:`, record a failed attempt and escalate.
5. **Report** one line per task: `SMR: ✓ docs → smr-fast · ✓ auth → smr-architect (escalated)`.

Don't split work into tiny subtasks unless they are truly independent.
