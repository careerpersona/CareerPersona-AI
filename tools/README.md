# Developer Toolkit

Internal developer tooling — not a product feature, no user-facing code. Full
design rationale: [`docs/architecture/Developer-Toolkit-Architecture.md`](../docs/architecture/Developer-Toolkit-Architecture.md).

## Built (all 5 tools implemented, approved 2026-08-22)

| Tool | Purpose | Usage |
|---|---|---|
| [`regression-runner/`](regression-runner/index.js) | Consolidates registered `scripts/verify/*.cjs` Playwright suites into one report. Runs each suite unchanged as a child process. | `node tools/regression-runner/index.js [--suite=<id>] [--feature=<name>] [--parallel] [--format=console\|json\|md] [--out=<path>]` |
| [`localization-validator/`](localization-validator/index.js) | Coverage, diff-purity, namespace-collision, and heuristic hardcoded-string checks across all 14 locales. | `node tools/localization-validator/index.js --check=coverage,diff-purity,collision,hardcoded [--namespace=<ns>] [--key=<name>] [--files=<a.jsx,b.jsx>]` |
| [`architecture-validator/`](architecture-validator/index.js) | Detects duplicate business logic / module-ownership violations against the rule registry in [`config/ownership-rules.json`](config/ownership-rules.json). Two-tier: `hardFailPatterns` hits are always violations; `advisoryPatterns` hits are reported for manual review, never auto-failed (Referral Intelligence's Phase 9 audit found only the unambiguous pattern was safely fully-automatable). | `node tools/architecture-validator/index.js [--rule=<id>] [--feature=<name>] [--format=console\|json\|md] [--out=<path>] [--strict]` |
| [`rc-validator/`](rc-validator/index.js) | Automates a feature's Release Candidate checklist as one command: `npx vite build`, `npx eslint .`, Architecture Validator, Localization Validator, and the Regression Runner (which already includes that feature's registered responsive suite, if any). Never deploys — a passing report is evidence for a human decision, not a trigger. | `node tools/rc-validator/index.js --feature=<name> [--format=console\|json\|md] [--out=<path>] [--strict]` |
| [`adr-generator/`](adr-generator/index.js) | Renders a standardized ADR (`template.md`, matching the section structure of every existing ADR in `docs/architecture/`) from a human-authored decisions file plus an RC Validator report — the Evidence section is generated from what the RC run actually found, never typed from memory. Refuses to overwrite an existing `--out` file unless `--force` is given. | `node tools/adr-generator/index.js --feature=<name> --decisions=<path-to-decisions.json> [--rc-report=<rc-report.json>] --out=<path> [--force]` |

All five consume shared infrastructure in [`shared/`](shared/) (report schema, CLI parsing, exit codes, config loading, plus [`responsiveCheck.js`](shared/responsiveCheck.js) — the `noHorizontalOverflow` helper extracted from `verify-referral-intelligence-responsive.cjs` for future verification scripts to import) and read their registries from [`config/`](config/) — `regression-suites.json`, `localization.config.json`, `ownership-rules.json`, `rc-checklist.json`.

**Prerequisite for `regression-runner`, and for `rc-validator` when its checklist includes `regression`:** dev server running at `http://localhost:5173` (same requirement every registered suite already documents individually).

**Exit codes** (shared across every tool): `0` = pass, `1` = fail (a real finding), `2` = tool error (bad config, missing file — distinct from a real finding).

**Known limitations** (see the architecture-reconciliation note in the implementation report for full detail):
- `rc-validator`'s lint step runs `eslint .` against the whole repo — there is no changed-file-tracking mechanism in this repo to scope it to just a feature's files.
- `rc-validator`'s localization step always runs `coverage,diff-purity` repo-wide — there is no per-feature translation-key manifest format.
- `rc-validator` does not launch its own Playwright session for responsive checks — that coverage comes from whichever suites a feature has registered with the Regression Runner.
- `ownership-rules.json` currently registers one rule (`referral-scoring-single-owner`, transcribed from ADR-Referral-Intelligence.md). Extending it to the rest of the modules documented in `AI-Ownership-Registry.md` is future work, not done speculatively here — each would need its own reviewed regex pattern.

## Reports

`tools/reports/` is gitignored — generated output is reproducible from the tools themselves, not committed as source.
