# Developer Toolkit

Internal developer tooling — not a product feature, no user-facing code. Full
design rationale: [`docs/architecture/Developer-Toolkit-Architecture.md`](../docs/architecture/Developer-Toolkit-Architecture.md).

## Built (approved for implementation)

| Tool | Purpose | Usage |
|---|---|---|
| [`regression-runner/`](regression-runner/index.js) | Consolidates registered `scripts/verify/*.cjs` Playwright suites into one report. Runs each suite unchanged as a child process. | `node tools/regression-runner/index.js [--suite=<id>] [--feature=<name>] [--parallel] [--format=console\|json\|md] [--out=<path>]` |
| [`localization-validator/`](localization-validator/index.js) | Coverage, diff-purity, namespace-collision, and heuristic hardcoded-string checks across all 14 locales. | `node tools/localization-validator/index.js --check=coverage,diff-purity,collision,hardcoded [--namespace=<ns>] [--key=<name>] [--files=<a.jsx,b.jsx>]` |

Both consume shared infrastructure in [`shared/`](shared/) (report schema, CLI parsing, exit codes, config loading) and read their registries from [`config/`](config/) — `regression-suites.json` and `localization.config.json`.

**Prerequisite for `regression-runner`:** dev server running at `http://localhost:5173` (same requirement every registered suite already documents individually).

**Exit codes** (shared across every tool): `0` = pass, `1` = fail (a real finding), `2` = tool error (bad config, missing file — distinct from a real finding).

## Deferred (architecture approved, implementation not started)

- Architecture Validator
- Release Candidate Validator
- ADR Generator

These remain part of the approved toolkit architecture but were explicitly **not** approved for implementation as of 2026-08-02. No stub files, folders, or placeholders exist for them — see the architecture doc for their intended design when that milestone is reached.

## Reports

`tools/reports/` is gitignored — generated output is reproducible from the tools themselves, not committed as source.
