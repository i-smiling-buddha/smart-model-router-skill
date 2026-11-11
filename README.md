# Smart Model Router (SMR)

**One Task. Right Model. Better Results.**

> Use the cheapest model that can reliably complete the task, and escalate only when necessary.

SMR हर coding task को समझता है, उसके लिए सबसे सही model चुनता है, result verify करता है और
fail होने पर ही stronger model पर जाता है। लक्ष्य है **Minimum Cost per Successful Task** —
सिर्फ minimum cost per token नहीं।

**Status:** Phase 1 (MVP) — Core Engine + CLI + Claude Code और OpenCode integration ready।

---

## Quick Start

```bash
npm install
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

`--json` output skills और agents के लिए है। Hindi और Hinglish tasks भी समझता है
(`"लॉगिन बग ठीक करो"`, `"पूरा authentication system बनाओ"`)।

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
│   └── test/                 Vitest suite
├── apps/cli/               `smr` command
├── integrations/
│   ├── claude-code/          Skill + 3 subagents + config
│   └── opencode/             Router agent + 3 subagents + config
└── docs/ROADMAP.md
```

## Honest limitations

- कोई भी skill host का **main model चुपचाप नहीं बदल सकती**। SMR subagents (जिनका अपना `model:`
  है) को delegate करके काम करता है — यही Claude Code और OpenCode दोनों का supported तरीका है।
- Classifier अभी keyword-based है; ambiguous tasks पर `confidence` कम आता है। LLM fallback
  classification Phase 2 में है।
- Actual token usage अभी host track करता है; SMR का cost **estimate** है।

License: MIT
