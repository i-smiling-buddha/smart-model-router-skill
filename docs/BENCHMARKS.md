# Benchmarks

The point of SMR is to save money **without** failing more tasks. `smr bench` measures exactly that.

```bash
smr bench --allow-code-exec                          # starter suite, real API calls
smr bench my-suite.json --strategies smr,smr:economy,best,single:anthropic/claude-sonnet-5-5 --allow-code-exec
smr bench --simulate --seed 7                        # offline demo — labelled SIMULATED everywhere
smr bench --allow-code-exec --import                 # also feed results into the Learning Engine
```

## Strategies

| Strategy | Meaning |
|---|---|
| `smr` / `smr:economy` / `smr:quality` | full routing + escalation in that mode |
| `best` | the strongest available model for every case (retries allowed, no escalation) |
| `single:<model-id>` | one model for everything (default: the standard-tier model) |

Every case runs under every strategy with its own isolated log, so nothing learned in one run
leaks into another.

## Verdict

For each baseline, SMR **passes** only if its success rate is not lower **and** its cost is lower
(or it buys strictly higher success). "50% fewer tokens but 30% more failures" is a **fail**.
Reports are saved to `.smr/benchmarks/` and shown in the dashboard.

## Suite format

```json
{
  "name": "my-suite",
  "cases": [
    { "id": "docs", "task": "Write a README intro for …", "verify": { "type": "contains", "values": ["smr"] } },
    { "id": "regex", "task": "…", "verify": { "type": "regex", "pattern": "sql\\s*injection", "flags": "i" } },
    { "id": "json", "task": "…", "verify": { "type": "json", "requiredKeys": ["name", "version"] } },
    { "id": "code", "task": "Write isPalindrome(s) …", "verify": { "type": "node-test", "test": "import assert from 'node:assert'; assert.equal(isPalindrome('aba'), true);" } }
  ]
}
```

`contains` supports `all: true` and `caseSensitive: true`.

> ⚠️ **`node-test` runs the model's code on your machine** (temp folder, 10 s timeout). SMR refuses
> to run such suites unless you pass `--allow-code-exec`. Only use suites you trust.

## Simulated runs

`--simulate` needs no API keys: each model's "true" skill is its registry prior plus a fixed
per-category offset, and pass/fail is drawn from that with a seeded RNG. It is useful to see the
reports and dashboard, **not** as evidence. Simulated reports are marked everywhere and are not
imported into learning unless you add `--import-simulated`.

## Publishing results

No real-API results are published yet. If you run the starter suite, please share the JSON from
`.smr/benchmarks/` in an issue — with the models, date and SMR version.
