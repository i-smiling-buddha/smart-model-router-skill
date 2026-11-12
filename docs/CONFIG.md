# Configuration

## `smr.config.json`

Read from the current folder (or `--config <file>`). Every key is optional.

```jsonc
{
  "mode": "smart",                 // smart | economy | quality
  "host": "claude-code",           // claude-code | opencode | codex | generic — how models are named in output
  "approval": "auto",              // auto | confirm | recommend — read by the skills
  "registryPath": "smr.registry.json",
  "storeDir": ".smr",              // execution log folder
  "maxRetriesPerModel": 2,         // tries on one model before escalating
  "maxEscalations": 2,             // tier jumps per task before stopping
  "costCeilingUsd": 0.50,          // stop and ask when a task has spent this much (needs pricing)
  "minSuccessProbability": 0.6,    // reliability floor for normal tasks (critical tasks: 0.8)
  "checks": [                      // replaces auto-detection from package.json scripts
    { "name": "typecheck", "command": "npx tsc --noEmit", "level": "static" },
    { "name": "test", "command": "npm test", "level": "functional", "timeoutMs": 300000 }
  ],
  "llmClassifier": {               // refine low-confidence classifications with a cheap model
    "enabled": false,
    "model": "claude-haiku-5-5",   // or a registry id like "openrouter/vendor/model" / "ollama/qwen3"
    "threshold": 0.6
  },
  "learning": {                    // adaptive ranking from the log — on by default
    "enabled": true,
    "priorStrength": 8,            // how many observations the registry prior is worth
    "minTokenSamples": 3,
    "pooledWeight": 0.5
  },
  "optimizer": { "contextBudgetTokens": 8000 },
  "server": { "port": 4317 }
}
```

### Checks

Without `checks`, SMR reads your `package.json` scripts: `typecheck` / `type-check` / `lint` /
`build` → static, `test` → functional (pnpm/yarn detected from lockfiles). Python projects with
`pyproject.toml` or `pytest.ini` get `python -m pytest -q`. Which levels run depends on the task —
documentation and planning only get the semantic checklist.

## Model registry

The built-in registry has Claude Haiku 5.5, Sonnet 5.5 and Opus 5.5 (Fable 5.2 present but
disabled). To add prices, other providers or your own scores, create `smr.registry.json`
(start from `smr.registry.example.json`) and point `registryPath` at it. Entries are merged over the
defaults by `id`.

```jsonc
{
  "version": 1,
  "models": [
    {
      "id": "openrouter/vendor/model",          // "<provider>/<model>" — the prefix picks the adapter
      "provider": "openrouter",
      "displayName": "Some Model",
      "tier": "budget",                          // budget | standard | premium | frontier
      "hostAliases": { "opencode": "openrouter/vendor/model" },
      "scores": { "coding": 70, "reasoning": 65, "debugging": 60, "creative": 60, "instructionFollowing": 75, "speed": 90 },
      "scoreSource": "initial-estimate",         // initial-estimate | provider | benchmark | observed
      "pricing": { "inputPerMTok": 0.5, "outputPerMTok": 1.5 },   // USD per 1M tokens, or null
      "relativeCost": 0.5,                       // used when pricing is null (cheapest ≈ 1)
      "capabilities": { "toolCalling": true, "vision": false },
      "available": true
    }
  ]
}
```

Providers: `anthropic`, `openai`, `openrouter`, `google`, `ollama`. Prices change — copy them from
each provider's current pricing page; SMR never guesses them.

## Environment variables

| Variable | |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY` | provider keys (read from the environment only; never logged or stored) |
| `OLLAMA_HOST` | Ollama URL (default `http://localhost:11434`) |
| `SMR_API_TOKEN` | require a bearer token on `smr serve` |
