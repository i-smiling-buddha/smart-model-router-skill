# Smart Model Router (SMR) Skill — हिंदी गाइड

![Smart Model Router — AI model auto-switching skill for vibe coders](Smart%20Model%20Router%20Infographic.png)

> English: [README.md](README.md) · Install: [docs/INSTALL.md](docs/INSTALL.md)

**One Task. Right Model. Better Results.**

> Use the cheapest model that can reliably complete the task, and escalate only when necessary.

SMR हर coding task को समझता है, उसके लिए सबसे सही model चुनता है, result verify करता है और
fail होने पर ही stronger model पर जाता है। लक्ष्य है **Minimum Cost per Successful Task** —
सिर्फ minimum cost per token नहीं।

**Status:** v1.0.0-rc.1 (release candidate) — पाँचों phases पूरे: Core Engine, Intelligence, Universal Integration, Optimization, Release।
Claude Code, OpenCode, Codex, किसी भी MCP host, local HTTP API, और सीधे provider APIs (Anthropic / OpenAI / OpenRouter / Gemini / Ollama) पर चलता है।

## Install (Windows)

```powershell
# repo clone करके:
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
# फिर अपने project folder में:
smr init claude-code
smr doctor
```

पूरी गाइड: [docs/INSTALL.md](docs/INSTALL.md)। Windows पर `smr init` MCP configs में अपने-आप `cmd /c smr mcp` लिखता है।

## Phase 4: Optimization

### Benchmark — क्या SMR सच में पैसे बचाता है?

```bash
smr bench                                   # starter suite: smr vs best vs single:sonnet (असली API calls)
smr bench --simulate                        # offline demo (API keys नहीं चाहिए) — साफ़ "SIMULATED" लिखा आता है
smr bench my-suite.json --strategies smr,smr:economy,best --import
```

हर case हर strategy में **अलग, isolated log** के साथ चलता है (fair comparison)। Verdict
success **और** cost दोनों देखता है — अगर SMR सस्ता है पर ज़्यादा tasks fail हुए, तो **FAIL**।
Starter suite (`benchmarks/suites/starter.json`) में 10 cases हैं; coding cases का code सच में
`node:assert` से run होकर verify होता है। ⚠️ `node-test` cases model का लिखा code आपकी machine पर
(temp folder, timeout के साथ) चलाते हैं — सिर्फ भरोसेमंद suites इस्तेमाल करो।
Results `.smr/benchmarks/` में save होते हैं; `--import` से Learning Engine उनसे सीखता है।

### Learning Engine — routing जो अनुभव से सुधरती है

```
p = (p_prior · k + passes) / (k + attempts)        k = priorStrength (default 8)
```

हर logged attempt (model × category × complexity) router की success probability और token
estimate को adjust करता है। कम data पर registry prior हावी रहता है, ज़्यादा data पर असली
नतीजे। Critical-task floors फिर भी लागू रहते हैं। `smr learn` prior → observed → blended दिखाता है;
routing reason में "learned from N runs" आता है। बंद करना हो: config में `"learning": {"enabled": false}`।

### Token Optimizer

```bash
smr context "fix the escalation retry limit" --dir src --budget 4000
#  smr context: 4 files, 25784 → 2991 tokens (88% saved)
```

Task के keywords से relevant files चुनता है, duplicates हटाता है, whitespace/minified/base64 compress
करता है, और बड़ी files में से सिर्फ relevant हिस्से (keyword windows) रखता है। `.env`/keys कभी नहीं जाते।
साथ में: history से output-length cap (`suggestMaxTokens`) और Anthropic prompt caching (`smr exec`)।
MCP tool: `smr_pack_context`।

### Dashboard

```bash
smr dashboard            # → .smr/dashboard.html (self-contained, offline, light + dark)
smr serve                # → http://127.0.0.1:4317/dashboard (live)
```

Usage tiles (tasks, success, tokens, **savings vs always-best model**), cost by model, pass-rate
heatmap (model × category), latest benchmark verdicts, Learning Engine table, recent tasks।

## Supported hosts

| Host | कैसे जुड़ता है | Install |
|---|---|---|
| **Claude Code** | Skill + `smr-fast/builder/architect` subagents (haiku/sonnet/opus) + MCP + SubagentStop hook (auto token capture) | `smr init claude-code` |
| **OpenCode** | `smr-router` primary agent + subagents + MCP (`opencode.json`) | `smr init opencode` |
| **Codex** | Skill (`.agents/skills`) + custom agents (`.codex/agents/*.toml`) + MCP (`.codex/config.toml`) + `AGENTS.md` | `smr init codex` |
| **कोई भी MCP host** (Cursor, VS Code agents…) | `smr mcp` — 10 tools: `smr_route`, `smr_task_start`, `smr_verify`, `smr_task_attempt`, `smr_task_next`, `smr_task_handoff`, `smr_execute`, `smr_classify`, `smr_models`, `smr_report` | host के MCP config में `command: "smr", args: ["mcp"]` |
| **Custom agents / scripts** | `smr serve` — local HTTP API, या `smr exec` — सीधा provider call | — |

`smr init` आपकी मौजूदा files (जैसे `opencode.json`, `.claude/settings.json`, `AGENTS.md`)
**कभी overwrite नहीं करता** — skip हुई files की list दिखाता है, SMR वाला हिस्सा हाथ से merge कर लेना।
सब hosts के लिए `smr` PATH पर होना चाहिए: `npm link -w @smr/cli`।

---

## Quick Start

```bash
npm ci
npm run build
npm test

# किसी task को route करो
npm run smr -- route "add a dark mode toggle to the settings page" --host claude-code
#  → sonnet   (anthropic/claude-sonnet-5-5)
#    moderate development → Claude Sonnet 5.5: lowest expected cost per successful task (p≈99%, mode=smart)
```

Global command चाहिए तो: `npm link -w @smr/cli` → फिर कहीं से भी `smr route "..."`।

### अपने project में install करो

```bash
smr init claude-code  path/to/your-project   # .claude/skills + .claude/agents + smr.config.json
smr init opencode     path/to/your-project   # .opencode/agents + smr.config.json
```

**Claude Code में:** बस normally काम करो, या बोलो *"use SMR"*। Skill हर task को
`smr-fast` (haiku) / `smr-builder` (sonnet) / `smr-architect` (opus) subagent पर भेजेगी।
Main session को Sonnet पर रखना सबसे सस्ता orchestration है।

**OpenCode में:** `smr-router` primary agent select करो (Tab से switch होता है)। वो subagents
को `subagent` tool से call करेगा।

---

## CLI

| Command | काम |
|---|---|
| `smr route "<task>" [--mode smart\|economy\|quality] [--host ...] [--json]` | Classify + model चुनना, सभी candidates के scores के साथ |
| `smr classify "<task>" [--json]` | सिर्फ category, complexity, risk |
| `smr escalate "<task>" --from <model> --attempts N [--reason "..."]` | Retry / escalate / stop decision |
| `smr models [--json]` | Registry देखना |
| `smr init <claude-code\|opencode> [dir]` | Integration files copy करना |

| `smr task start "<task>"` | Task open करना + log करना, task id और model मिलता है |
| `smr verify <id> --model <m>` | Task की ज़रूरत के checks चलाना, attempt record करना, next step बताना |
| `smr task attempt <id> --model <m> --pass\|--fail [--reason] [--input-tokens N --output-tokens N]` | Attempt manually record करना |
| `smr task next <id>` | Real history से retry / escalate / stop / complete |
| `smr task handoff <id> [--constraint "..."] [--file path]` | अगले model के लिए compact handoff (failure history के साथ) |
| `smr task show <id>` · `smr report` | Task detail · per-model pass rate, tokens, cost |

`--json` output skills और agents के लिए है। Hindi और Hinglish tasks भी समझता है
(`"लॉगिन बग ठीक करो"`, `"पूरा authentication system बनाओ"`)।

| `smr exec "<task>" [--system "..."]` | Provider API को सीधे call करना: route → call → verify → escalate, usage auto-log |
| `smr mcp` | MCP server (stdio) |
| `smr serve [--port 4317]` | Local HTTP API (सिर्फ 127.0.0.1; optional `SMR_API_TOKEN`) |
| `smr hook subagent-stop` | Claude Code hook — subagent transcript से tokens capture करता है |

### Direct execution & providers (Phase 3)

`smr exec` उन tasks के लिए है जिन्हें files edit नहीं करनी (docs, plans, explanations, snippets),
या custom agents के लिए जो खुद model switch नहीं कर सकते:

```bash
export ANTHROPIC_API_KEY=...        # ज़रूरत के हिसाब से: OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY
smr exec "write README docs for the auth module"
#   ✓ anthropic/claude-haiku-5-5  in 812 / out 640
```

Registry model id का prefix provider चुनता है: `anthropic/…`, `openai/…`, `openrouter/<vendor>/<model>`,
`google/…`, `ollama/…` (local, बिना key; `OLLAMA_HOST`)। Keys सिर्फ environment से पढ़ी जाती हैं —
कभी log, store या prompt में नहीं जातीं। Model अगर `ESCALATE:` जवाब दे या provider down हो
(429/5xx/no key), तो retry skip करके सीधे अगले tier पर जाता है।

### HTTP API (`smr serve`)

| Endpoint | काम |
|---|---|
| `GET /health` · `GET /models` · `GET /usage` (`/analytics`) | Status, registry, report |
| `POST /tasks/classify` · `POST /tasks/route` | Classification / routing |
| `POST /tasks` | Task start |
| `POST /tasks/:id/attempts` · `GET /tasks/:id/next` · `POST /tasks/:id/handoff` · `GET /tasks/:id` | Lifecycle |
| `POST /tasks/evaluate` · `POST /tasks/execute` | Verify / direct execution |

HTTP और MCP दोनों **एक ही Common API** (`packages/server/src/api.ts`) पर चलते हैं — same schema,
same routing, same result format।

### Task lifecycle (Phase 2)

```bash
smr task start "add a dark mode toggle to the settings page" --host claude-code
#  task t_mwbq1fy1ac123b  → sonnet
smr verify t_mwbq1fy1ac123b --model sonnet      # typecheck ✓  test ✗  → RETRY → sonnet
smr verify t_mwbq1fy1ac123b --model sonnet      # test ✗           → ESCALATE → opus
smr task handoff t_mwbq1fy1ac123b --constraint "Keep existing theme API"
smr verify t_mwbq1fy1ac123b --model opus        # ✓                → COMPLETE
smr report
```

**Quality Evaluator:** `static` (typecheck/lint/build) → `functional` (tests, सिर्फ तब जब static
pass हो) → `semantic` (requirement checklist, host model या आप tick करते हैं)। Checks
`package.json` scripts से auto-detect होते हैं, या `smr.config.json` में `"checks"` से set करो।
README जैसे tasks पर कोई command नहीं चलता।

**Execution Log:** `.smr/smr.db` (Node ≥ 22.5 का built-in `node:sqlite`), नहीं तो `.smr/log.json`।
सब local रहता है। इसे `.gitignore` में डालो।

**LLM fallback classifier:** सिर्फ तब जब rule-based confidence < 0.6 हो। Cheap model
(default `claude-haiku-5-5`) से पूछता है, answer cache करता है, और rules ने जो risk पकड़ा उसे
कभी कम नहीं करता। चालू करने के लिए `--llm` या config में `"llmClassifier": {"enabled": true}`,
और env में `ANTHROPIC_API_KEY`। Key कभी log या prompt में नहीं जाती।

---

## Routing कैसे होती है

```
Score(m,t) = 0.35·Q + 0.25·S + 0.20·R + 0.10·C + 0.10·L      (smart mode)
```

| | Meaning |
|---|---|
| **Q** Quality | Model की capability task की demand clear करती है या नहीं (capped — ज़रूरत से ज़्यादा power का कोई extra point नहीं) |
| **S** Suitability | Right-sized fit — कम power खराब, बहुत ज़्यादा overkill भी थोड़ा खराब |
| **R** Reliability | p(success) × 100, capability vs task demand से |
| **C** Cost efficiency | सबसे सस्ता *expected cost per success* ÷ इस model का (`cost / p(success)`) |
| **L** Latency | Speed score |

**Hard rules (cost से कभी नहीं टूटते):**
- Critical tasks (security, payments, auth, secrets, production data) → success floor 80%
- Vision ज़रूरी हो तो सिर्फ vision models
- Context window और cost ceiling check
- अगर कोई भी model floor clear न करे → strongest model + "human review" warning

**Modes:** `smart` (default) · `economy` (cost को ज़्यादा weight) · `quality` (quality को ज़्यादा weight)

**Escalation:** same model पर 1 retry → 2 failures के बाद एक tier ऊपर → max 2 escalations → फिर
रुककर user से पूछना। Context-window वाली failure पर retry skip, सीधे escalate।

### Sample routing (default registry)

| Task | Model |
|---|---|
| fix typo in README | haiku |
| find where the login handler is | haiku |
| write unit tests for the cart utils | haiku |
| add a dark mode toggle to the settings page | sonnet |
| लॉगिन बग ठीक करो | sonnet |
| debug race condition in the websocket reconnect logic | opus |
| पूरा authentication system बनाओ | opus |
| security audit of payment gateway integration | opus (economy mode में भी) |

---

## Model Registry

Default registry में Claude Haiku 5.5, Sonnet 5.5, Opus 5.5 हैं (Fable 5.2 default में **disabled**
है — access हो तो enable करो)।

⚠️ **ज़रूरी:**
- सारे **scores initial estimates** हैं (`scoreSource: "initial-estimate"`) — Phase 4 के
  benchmarks इन्हें replace करेंगे।
- **Pricing जानबूझकर `null` है।** Provider के current pricing page से भरो, तब CLI USD में cost
  दिखाएगा। तब तक comparison के लिए `relativeCost` index इस्तेमाल होता है।

Prices भरने या दूसरे providers जोड़ने के लिए: `smr.registry.example.json` copy करो →
`smr.registry.json`, edit करो, और `smr.config.json` में `"registryPath": "smr.registry.json"`
डालो (या `--registry` flag)। Entries id के हिसाब से defaults पर merge होती हैं।

---

## Project Structure

```
smart-model-router/
├── packages/core/          SMR Core Engine
│   ├── src/classifier.ts     Task Classifier (rule-based, EN + हिंदी + Hinglish)
│   ├── src/registry.ts       Model Registry (zod-validated)
│   ├── src/router.ts         Intelligent Router (weighted scoring + hard rules)
│   ├── src/cost.ts           Cost estimator + per-task ledger
│   ├── src/escalation.ts     Fallback & Escalation Manager
│   ├── src/handoff.ts        Context Manager (compact handoff + secret redaction)
│   ├── src/evaluator.ts      Quality Evaluator (static → functional → semantic)
│   ├── src/store.ts          Execution Log (SQLite / JSON)
│   ├── src/session.ts        Task lifecycle + history-based retry management
│   ├── src/llm-classifier.ts Hybrid classification (low confidence → cheap LLM, cached)
│   └── test/                 Vitest suite
│   ├── src/providers.ts      Provider adapters (Anthropic, OpenAI-compatible, Gemini)
│   ├── src/executor.ts       Direct executor (route → call → verify → escalate)
│   ├── src/hooks.ts          Transcript usage parser (Claude Code hooks)
│   ├── src/learning.ts       Learning Engine (Bayesian blend of prior + observed)
│   ├── src/optimizer.ts      Token Optimizer (context packing, compression, output caps)
│   ├── src/benchmark.ts      Benchmark engine (strategies, verifiers, simulation, import)
│   ├── src/insights.ts       Learning report + savings estimate
│   ├── src/dashboard.ts      Self-contained HTML dashboard
│   └── src/config.ts         Shared smr.config.json loading
├── packages/server/        Common SMR API → HTTP server + MCP stdio server
├── apps/cli/               `smr` command
├── integrations/
│   ├── claude-code/          Skill + 3 subagents + .mcp.json + SubagentStop hook + config
│   ├── opencode/             Router agent + 3 subagents + opencode.json (MCP) + config
│   └── codex/                Skill + 3 TOML agents + .codex/config.toml (MCP) + AGENTS.md
├── benchmarks/suites/      Benchmark suites (starter.json)
└── docs/ROADMAP.md
```

## Honest limitations

- कोई भी skill host का **main model चुपचाप नहीं बदल सकती**। SMR subagents (जिनका अपना `model:`
  है) को delegate करके काम करता है — यही Claude Code और OpenCode दोनों का supported तरीका है।
- LLM classifier का live API call यहाँ test नहीं हुआ (sandbox में network नहीं था) — logic mock
  backend से test है। पहली बार `--llm` चलाकर check कर लेना।
- Live provider API calls (Anthropic/OpenAI/OpenRouter/Gemini/Ollama) यहाँ network न होने से test
  नहीं हुए — request/response shapes mock से test हैं। पहली बार `smr exec` चलाकर check कर लेना।
- Codex agent files में model names (`gpt-5.4-mini`, `gpt-5.5`) अपने account के available models
  से **verify करके** बदल लेना।
- Automatic token capture अभी सिर्फ Claude Code में है (SubagentStop hook)। OpenCode/Codex में
  tokens `--input-tokens/--output-tokens` या `smr_task_attempt` से record होते हैं; `smr exec`
  हर host पर usage खुद log करता है।

License: MIT
