---
name: smart-model-router
description: Save tokens and API credits on coding work — route each task to the cheapest model/agent that can reliably do it (fast, standard or advanced tier), verify the result, and escalate only when it fails. Use for multi-step coding work, or when the user asks to save tokens/credits, route models, or "use SMR".
license: MIT
compatibility: Works in any agent that can delegate to subagents or switch models (Claude Code, OpenCode, Codex, Cursor and others). Optional smr CLI (Node.js 20+) adds logging, verification, learning and a dashboard — see the project README.
---

# Smart Model Router (SMR)

**Principle:** use the cheapest model that can *reliably* complete the task; escalate only when
necessary. The goal is the minimum cost per **successful** task — a cheap model that fails three
times is not cheap.

You are the orchestrator. Classify, delegate, verify, report. Keep your own work light.

## 1. Pick the tier

| Tier | Typical models | Use for |
|---|---|---|
| **fast** | Haiku-class, `*-mini`, small local models | finding files, exploring code, README/docs, comments, typos, formatting, renames, tiny CSS/text fixes, simple tests |
| **standard** | Sonnet-class, main coding models | normal features, moderate bugs, refactors, test suites, code review |
| **advanced** | Opus-class, top reasoning models | architecture/planning, "entire / from scratch" work, complex or multi-file debugging, race conditions, concurrency, migrations |

Rules that override cost — **never below advanced**:
- security audits, auth, payments, secrets, production data, anything that risks data loss.

Other rules:
- Needs to look at an image/screenshot → a model with vision.
- Don't split work into tiny subtasks unless they are truly independent; orchestration costs tokens too.
- If the `smr` CLI is installed (`smr --version` works), let it decide instead of this table:
  `smr task start --json "<task>"` → use `decision.hostModel`; keep the `taskId`.

## 2. Delegate with a compact handoff

Use the host's mechanism for running work on a specific model — a subagent with its own model
(Claude Code `model:`, OpenCode/Codex agent files), a model switch, or a separate session. If the
host can't switch models at all, tell the user which tier you recommend and continue.

Give the worker only what it needs, never the whole conversation:

```
Task: <one line>
Original requirement: <user's words>
Constraints (must keep): <APIs to preserve, style, user decisions>
Relevant files: <paths>
Expected output: <what "done" looks like>
Earlier failed attempts: <tier: reason>   (only on retry/escalation)
```

Never put API keys, `.env` contents, private keys or credentials into a handoff.

Tell fast-tier workers: *if the task turns out bigger or riskier than described, reply
`ESCALATE: <reason>` instead of guessing.*

## 3. Verify — match effort to the task

- Code changes → typecheck / lint / build, then the relevant tests (skip tests if the build fails).
- Docs, plans, explanations → re-read the user's requirement and check the output matches.
- Never run a full test suite for a README.

With the CLI: `smr verify <taskId> --model <model> --json` runs the needed checks, records the
attempt and returns `next`.

## 4. Retry or escalate (hard limits)

1. Failed once → retry the **same** tier once, including the failure output.
2. Failed twice → move **one tier up** with the handoff + failure history.
3. Worker replied `ESCALATE:` or ran out of context → move up immediately.
4. At most **2 escalations** per task. Then stop, explain what failed, and ask the user.

## 5. Report in one line per task

```
SMR: ✓ docs → fast · ✓ login endpoint → standard (1 retry) · ✓ race condition → advanced (escalated)
```

## More

Full engine (logging, learning, benchmarks, dashboard, MCP server, ready-made subagents for
Claude Code / OpenCode / Codex): https://github.com/i-smiling-buddha/smart-model-router-skill
