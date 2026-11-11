# Agent instructions

## Smart Model Router
For multi-step coding work in this repo, use the `smart-model-router` skill:
route each task with `smr_task_start` (host `codex`), **explicitly spawn** the agent it returns
(`smr-fast`, `smr-builder` or `smr-architect`), verify with `smr_verify`, and follow `next.action`.
Prefer the cheapest agent that can do the job reliably; escalate only after verification fails.
