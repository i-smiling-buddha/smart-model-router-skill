---
name: smart-model-router
description: Route each coding task to the cheapest Claude model that can reliably do it (Haiku / Sonnet / Opus subagents), verify the result, and escalate only on failure. Use for any multi-step coding work, or when the user asks to save tokens/credits, route models, or "use SMR".
---

# Smart Model Router (SMR)

**Principle:** use the cheapest model that can reliably complete the task; escalate only when necessary.
Goal = minimum cost per *successful* task — not minimum cost per token.

You (the main session) are the **orchestrator**. Keep your own work light: classify, delegate,
verify, report. Hand the heavy lifting to the routed subagent.

## Subagents (installed in `.claude/agents/`)

| Subagent        | Model  | Use for |
|-----------------|--------|---------|
| `smr-fast`      | haiku  | exploration, finding files, docs/README, typos, formatting, simple tests, tiny CSS/text fixes |
| `smr-builder`   | sonnet | normal implementation, moderate bugs, refactors, test suites, code review |
| `smr-architect` | opus   | architecture/planning, complex or multi-file debugging, security/payments/auth, critical work |

## Procedure — for every task the user gives

### 1. Route
If the `smr` CLI is available (check once: `smr --help` or `npx smr --help`), run:

```bash
smr route --host claude-code --json "<the task, one line>"
```

Read `decision.hostModel` (`haiku` | `sonnet` | `opus`), `decision.routingReason`,
`decision.verificationLevels` and `decision.fallbackModels`.

If the CLI is not available, classify yourself with this table:

| Signal in the task | Route |
|---|---|
| typo, rename, README/docs, comments, formatting, "where is", explore, simple tests | haiku → `smr-fast` |
| add/build a feature, normal bug, refactor, review, write a test suite | sonnet → `smr-builder` |
| "entire/whole/from scratch", architecture, race condition, concurrency, migration, multi-file, auth/payments/security/production data | opus → `smr-architect` |

Rules that override cost:
- Security audit, payments, auth, secrets, production data, data loss → **never below opus**.
- Needs image understanding (screenshot/mockup) → a model with vision.
- Don't split a task into tiny subtasks unless they are truly independent — orchestration overhead costs tokens too.

### 2. Approval mode
Default is **auto** (just route). If `smr.config.json` has `"approval": "confirm"`, show one line —
`SMR → sonnet (moderate development, p≈99%). OK?` — and wait. If `"recommend"`, show the
recommendation and let the user pick.

### 3. Delegate with a compact handoff
Call the routed subagent. Give it ONLY what it needs — never the whole conversation:

```
## Task Handoff
Task: <one line>
Original requirement: <user's words>
Constraints (must keep): <API compatibility, style, user decisions — never drop these>
Relevant files: <paths>
Completed so far: <...>
Remaining: <...>
Expected output: <what "done" looks like>
Earlier failed attempts: <model: reason>   (only on retry/escalation)
```

Never put API keys, `.env` contents, private keys or credentials into a handoff.

### 4. Verify (match effort to the task)
- `static` → typecheck / lint / build
- `functional` → run the relevant tests
- `semantic` → re-read the user's requirement and check the output matches

A README needs only `semantic`. Don't run a full test suite for docs.

### 5. Retry / escalate (hard limits)
- Failed once → retry the **same** subagent once, including the failure output.
- Failed twice → escalate one tier (haiku → sonnet → opus) with the handoff + failure history.
  With the CLI: `smr escalate --host claude-code --from <model> --attempts 2 --reason "<why>" "<task>"`.
- Max **2 escalations** per task. Then stop, explain what failed, and ask the user.
- If the context window is the problem, escalate immediately (retrying won't help).

### 6. Report (short)
End with one line per routed task:

```
SMR: ✓ docs → haiku · ✓ auth endpoint → sonnet (1 retry) · ✓ race-condition fix → opus (escalated from sonnet)
```

## Notes
- A skill cannot silently change the main session's model. SMR works by delegating to subagents
  that have their own `model:`. Running the main session on Sonnet keeps orchestration cheap.
- Model scores in the registry are initial estimates — tune them with `smr.registry.json` as you
  observe real results.
