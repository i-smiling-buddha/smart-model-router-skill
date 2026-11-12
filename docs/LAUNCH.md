# Launch kit — Smart Model Router

Starting points for announcements. Adapt each post to the community, say you are the author,
don't post identical text everywhere, and never ask for fake stars, votes or engagement.

> **Numbers rule:** only use numbers you measured. Today the honest ones are the routing examples,
> the retry → escalate flow, and context packing on this repo (35,625 → 2,977 tokens, 91.6%).
> Do **not** quote the simulated benchmark as savings. After a real `smr bench --allow-code-exec`
> run, put that result in the first line of every post — it is the strongest hook you will have.

## Assets

| Asset | File |
|---|---|
| Terminal demo GIF (real CLI output) | `docs/assets/smr-demo.gif` |
| Infographic | `Smart Model Router Infographic.png` |
| Social preview (1280×720, < 1 MB) | `docs/assets/social-preview.jpg` → upload in *Settings → General → Social preview* |

## One-line positioning

**Stop paying top-model prices for typo fixes.** An open-source skill that routes every coding
task to the cheapest AI model that can reliably do it — and escalates only when it fails.

## Short description

Smart Model Router (SMR) is a free, MIT-licensed skill for AI coding agents. It sends simple work
(docs, typos, exploring code) to a fast model, normal features to a standard model, and hard or
risky work (race conditions, payments, security) to the strongest one. It verifies results,
retries once, then escalates with a compact handoff. Install in one line:
`npx skills add i-smiling-buddha/smart-model-router-skill`.

## X / Twitter (thread)

1/ Most AI coding sessions use the most expensive model for everything — including fixing typos.

I built an open-source skill that routes each task to the cheapest model that can *reliably* do it, and escalates only when it fails. 🧵

2/ typo in README → fast model
dark-mode toggle → standard model
race condition / payment security audit → strongest model (security & payments are never routed lower)

[attach docs/assets/smr-demo.gif]

3/ It optimises cost per *successful* task, not per token. A cheap model that fails 3× isn't cheap — so it retries once, then escalates with a compact handoff (requirement + constraints + failure history, secrets redacted).

4/ Works in Claude Code, Codex, Cursor, OpenCode and 40+ agents:
`npx skills add i-smiling-buddha/smart-model-router-skill`

Optional CLI adds logging, learning from results, benchmarks and a dashboard. Free + MIT:
https://github.com/i-smiling-buddha/smart-model-router-skill

## Reddit (show-and-tell)

Good fits (read each sub's self-promotion rules first): r/ClaudeAI, r/ChatGPTCoding, r/LocalLLaMA
(mention Ollama support), r/opensource, r/SideProject, r/developersIndia.

**Title:** I made a free skill that stops my AI coding agent from using the most expensive model for everything

**Body:**

I kept burning credits because my agent used the top model for trivial edits. So I built Smart
Model Router — an open-source Agent Skill (MIT) that:

- routes each task to a fast / standard / advanced model based on what the task actually needs
- never routes security, auth, payments or production-data work below the strongest tier
- verifies the result (build/tests only when the task needs them — a README never triggers a test suite)
- retries once, then escalates with a compact handoff instead of the whole conversation

One-line install for Claude Code, Codex, Cursor, OpenCode and others:
`npx skills add i-smiling-buddha/smart-model-router-skill`

There's also an optional CLI/MCP server with a local log, learning from results, a benchmark
(SMR vs single model vs best model — it only "passes" if success doesn't drop) and a dashboard.

Honest limits: model scores start as estimates and improve from your own results; I haven't
published a real-API benchmark yet. Feedback on the routing rules is very welcome. I'm the author.

https://github.com/i-smiling-buddha/smart-model-router-skill

## Hacker News — Show HN

**Title:** Show HN: Smart Model Router – route coding tasks to the cheapest model that can do them

**Body:**

SMR is an open-source skill + optional CLI for AI coding agents. Instead of one model for
everything, it classifies each task (category, complexity, risk) and scores models on expected
cost per *successful* task: cost / p(success). Critical work (security, payments, secrets) has a
reliability floor cost can't override. It verifies results, retries once, escalates with a compact
handoff, and learns from logged outcomes (Bayesian blend of prior and observed pass rates).

It integrates via subagents (Claude Code, OpenCode, Codex), an MCP server, or a local HTTP API.
The benchmark mode compares SMR with a single model and the best model and fails SMR if success
drops. Model scores are initial estimates; real-API results aren't published yet.

https://github.com/i-smiling-buddha/smart-model-router-skill

## LinkedIn

AI coding assistants are great — but most of us use the most expensive model for everything,
including renaming a variable.

I've open-sourced **Smart Model Router**, a free skill that makes your AI agent pick the right
model for each task: a fast one for docs and small fixes, a standard one for features, and the
strongest one only for hard or risky work like concurrency bugs or payment security. It checks the
result and escalates only when something fails.

Works with Claude Code, Codex, Cursor, OpenCode and more:
`npx skills add i-smiling-buddha/smart-model-router-skill`

Free and MIT-licensed 👉 https://github.com/i-smiling-buddha/smart-model-router-skill

#OpenSource #AI #DeveloperTools #ClaudeCode #VibeCoding

## हिंदी post (X / LinkedIn / WhatsApp)

AI से coding करते हो? तो शायद typo ठीक करने के लिए भी सबसे महँगा model इस्तेमाल हो रहा है 😅

मैंने एक free, open-source skill बनाई है — **Smart Model Router**। यह हर काम के लिए सही model चुनती है:
- छोटे काम (docs, typo) → सस्ता, तेज़ model
- normal features → standard model
- मुश्किल या risky काम (race condition, payments, security) → सबसे ताकतवर model

काम verify करती है, और fail होने पर ही बड़े model पर जाती है।

Install (Claude Code, Codex, Cursor, OpenCode वगैरह):
`npx skills add i-smiling-buddha/smart-model-router-skill`

GitHub: https://github.com/i-smiling-buddha/smart-model-router-skill (हिंदी गाइड भी है)

## YouTube Shorts / Reels script (faceless, 30–40 s, Hindi voiceover)

1. **Hook (0–3 s)** — screen: bill/credits screen blurred. VO: "Typo ठीक करने के लिए भी सबसे महँगा AI model? पैसे बर्बाद।"
2. **Problem (3–10 s)** — screen: agent using one model for everything. VO: "ज़्यादातर AI coding tools हर काम एक ही बड़े model से करवाते हैं।"
3. **Demo (10–28 s)** — screen: `docs/assets/smr-demo.gif` full screen. VO: "Smart Model Router हर task देखकर model चुनता है — typo के लिए सस्ता, bug के लिए standard, security के लिए सबसे strong। Fail हुआ तो खुद escalate।"
4. **Install (28–35 s)** — screen: the `npx skills add …` line. VO: "बस एक command। Free और open source।"
5. **CTA (35–40 s)** — screen: GitHub URL. VO: "Link description में। Star करना मत भूलना।"

## Launch order (one channel per day)

1. Repo ready: social preview uploaded, topics + description set, Discussions on, 3–5 `good first issue`s open.
2. Day 1 — X thread + LinkedIn + Hindi post.
3. Day 2 — Reddit (one subreddit), answer every comment.
4. Day 3 — Show HN (weekday, morning US time ≈ evening IST); stay online to reply.
5. Day 4+ — another subreddit, dev.to / Hashnode write-up ("How I cut my AI coding bill by routing models"), Shorts.
6. Week 2 — pull requests to relevant awesome lists (search GitHub for `awesome claude code`, `awesome mcp servers`, `awesome agent skills`); follow each list's contribution rules.
7. After a real benchmark — repost with the measured number as the headline.

## Repository metadata

- **Description:** `Free open-source skill: routes every AI coding task to the cheapest model that can reliably do it, verifies, and escalates only on failure. Claude Code, Codex, Cursor, OpenCode, MCP.`
- **Website:** `https://desitechnology.com`
- **Topics:** `ai-agents`, `agent-skills`, `claude-code`, `codex`, `opencode`, `cursor`, `mcp`, `mcp-server`, `llm`, `model-routing`, `llm-router`, `cost-optimization`, `token-optimization`, `vibe-coding`, `ai-coding`, `developer-tools`, `anthropic`, `openai`, `ollama`, `typescript`

## Good first issues (ideas)

1. Add classifier keywords for another language (Marathi, Tamil, Bengali, Spanish…).
2. Add 5 benchmark cases for Python tasks (with `node-test`-style verifiers in Python).
3. Cursor rules template in `integrations/cursor/` with compat tests.
4. Usage-over-time line chart in the dashboard.
5. Docs: a short "SMR with Ollama only" guide.
