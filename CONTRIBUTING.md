# Contributing

Thanks for helping! Issues and pull requests are welcome — in English or Hindi.

## Setup

```bash
git clone https://github.com/i-smiling-buddha/smart-model-router-skill
cd smart-model-router-skill
npm ci
npm run build
npm test            # Node 22.12+ for the test tooling
```

`npm link -w @smr/cli` puts your build on PATH as `smr`.

## Guidelines

- **Keep the principle:** cheapest model that can *reliably* finish the task. Changes that save
  tokens but lower success need benchmark evidence (`docs/BENCHMARKS.md`).
- **Tests with every change.** Unit tests live next to each package (`packages/*/test`);
  host-template and CLI end-to-end tests in `tests/compat`. New host templates must pass
  `tests/compat/templates.test.ts`.
- **No secrets, no network in tests.** Use mock `fetch`/providers (see `packages/core/test/phase3.test.ts`).
- **Cross-platform.** Paths via `node:path`, no shell-specific syntax in code. CI runs Windows, macOS and Linux.
- **Model facts.** Don't hard-code prices; scores are labelled `initial-estimate` until measured.
- Run `npm run build && npm test` before opening a PR, and add a line to `CHANGELOG.md`.

## Good first contributions

- Benchmark results from real runs (share the JSON from `.smr/benchmarks/`).
- More benchmark cases, especially non-English tasks.
- Classifier keywords for more languages.
- New host templates (e.g. Cursor rules) with compat tests.

## Releasing (maintainers)

1. Update versions (root + `packages/*` + `apps/cli`) and `CHANGELOG.md`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z` — the Release workflow tests, builds, creates the
   GitHub release with the `.tgz` and installers, and publishes to npm if `NPM_TOKEN` is set.

By contributing you agree your work is licensed under the MIT License.
