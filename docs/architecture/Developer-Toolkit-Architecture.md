# Developer Toolkit Architecture

**Status:** Approved — all 5 tools implemented (Regression Runner and Localization Validator 2026-08-02; Architecture Validator, Release Candidate Validator, and ADR Generator 2026-08-22). See [`tools/README.md`](../../tools/README.md) for usage.
**Date:** 2026-08-02
**Scope:** Internal developer tooling only. Not a product feature. No user-facing code.

## Why this exists

Referral Intelligence's Phase 9 Release Candidate validation was done entirely by hand: five separate `scripts/verify/*.cjs` files, each hand-writing its own ~80-line Supabase session mock (`makeJWT`/`makeSession`/route stubs), its own ad hoc grep commands typed into Bash, its own manual line-range cross-checking against `git diff` output, and a manually-transcribed evidence section in the ADR. It worked, but every piece of it was rebuilt from scratch, and nothing from Referral Intelligence's validation process is directly reusable for the next feature without copy-paste.

Concretely, during Referral Intelligence:
- The `makeJWT`/`makeSession`/mocked-Supabase-route boilerplate was duplicated near-verbatim across `verify-referral-intelligence-phase6.cjs`, `verify-opportunity-phase7.cjs`, `verify-referral-intelligence-rc.cjs`, `verify-referral-intelligence-responsive.cjs`, and `verify-networking-phase2-structural.cjs` — five copies of the same ~80 lines.
- The "no referral logic outside `scoringEngine.js`" grep check was run by hand, with results interpreted by hand, twice (once scoped to `App.jsx` after Phase 7, once broadened to `src/` for the RC check) — no record of the exact commands survives anywhere except the conversation transcript.
- The locale-coverage check, the git-diff-purity check, and the namespace-collision check were each one-off Node scripts written, run, and deleted.
- The regression suite results were aggregated by running three scripts and reading `tail -4` of each by hand.
- The ADR's Evidence section was typed from memory of what the scripts had just printed, with no automated link between "what the tool found" and "what the ADR claims."

This is exactly the kind of duplicated-logic problem Referral Intelligence's own architecture was built to prevent — just at the tooling layer instead of the product layer. This document applies the same discipline: one owned implementation per concern, shared by every tool that needs it.

## Design principles

1. **Reuse, don't rewrite.** Every tool here formalizes something already done by hand during Referral Intelligence. Nothing is speculative.
2. **Existing `scripts/verify/*.cjs` files are not touched.** They stay exactly as they are — working, already-verified regression artifacts. The Regression/Test Runner *registers and runs* them; it does not require rewriting them. New verification work going forward should use the shared helpers instead of re-copy-pasting boilerplate, but nothing already committed needs to change.
3. **Be honest about what static analysis can and can't decide.** Phase 9's grep for duplicated company-matching logic returned 9 hits; 1 was the real implementation and 8 required a human reading each one to determine it was a different, legitimate concern (job-to-watchlist matching, application dedup, etc.) — only the ranking-comparator grep (1 hit, unambiguous) was safely fully-automatable. The Architecture Validator is designed around this reality: a two-tier hard-fail/advisory system, not a single pass/fail button.
4. **One report shape, everywhere.** Every tool emits the same JSON structure. The Release Candidate Validator's "one consolidated report" is just concatenation of that shape from four sub-tools; the ADR Generator consumes that same shape directly, so an ADR's Evidence section is never manually transcribed again.
5. **Config is data, not prose.** Referral Intelligence's ownership rule, its locale list, and its regression-suite list all existed only as prose (in memory files, in this ADR, in conversation). The toolkit needs them as machine-readable config so a tool can act on them without a human re-typing a grep pattern each time.

## Folder structure

```
tools/
  toolkit.config.json              # global settings: repo root, report output dir, default format
  shared/
    cli.js                         # arg parsing: --format, --out, --strict, --feature
    config.js                      # loads + validates tools/toolkit.config.json and tools/config/*.json
    report.js                      # Report class -- shared schema, toJSON/toMarkdown/toConsole/writeFile
    mockSupabaseSession.js         # makeJWT/makeSession/newCtx-equivalent, config-driven table routes
    exitCodes.js                   # PASS=0, FAIL=1, TOOL_ERROR=2
  config/
    ownership-rules.json           # Architecture Validator's rule registry
    localization.config.json       # Localization Validator's locale list + namespace map
    regression-suites.json         # Regression Runner's registered suite list
  architecture-validator/
    index.js
  localization-validator/
    index.js
  regression-runner/
    index.js
  rc-validator/
    index.js
  adr-generator/
    index.js
    template.md
  reports/                         # gitignored -- generated output lands here
```

`tools/` is a new top-level directory, separate from `scripts/verify/`. `scripts/verify/` remains the home for existing one-off/historical verification scripts; `tools/` is the home for the shared, reusable, config-driven toolkit. The Regression Runner is the bridge between them.

## Shared conventions

- **Invocation:** every tool is run as `node tools/<tool-name>/index.js [options]`. No global install, no build step — plain Node, matching the rest of this project's scripts.
- **Common flags:** `--format=console|json|md` (default `console`), `--out=<path>` (also write the report to a file), `--feature=<name>` (scope to one feature's config, used by the RC Validator and Regression Runner), `--strict` (promote advisory findings to failures).
- **Exit codes:** `0` = pass, `1` = fail (at least one hard-fail finding, or `--strict` with any advisory finding), `2` = tool error (bad config, missing file, etc. — distinct from a real finding, so a broken config doesn't silently read as "clean").
- **Console output format:** keeps the exact `✅`/`❌` + one-line summary convention already used throughout `scripts/verify/*.cjs`, so nothing about reading a tool's output needs to be relearned.
- **Paths:** every path in a finding is repo-root-relative with forward slashes, so reports are portable and diffable regardless of OS (this is a Windows dev machine; CI may not be).
- **Config format:** plain `.json` for all machine config — no new parsing dependency, consistent with there being no YAML/TOML config anywhere else in this repo's own source (Supabase's `config.toml` and `wrangler.toml` are third-party tool configs, not a precedent to follow here).

## Shared report schema

Every tool emits exactly this shape, whether printed to console, written as JSON, or rendered as Markdown:

```json
{
  "tool": "architecture-validator",
  "version": "1.0.0",
  "feature": "referral-intelligence",
  "generatedAt": "2026-08-02T20:00:00Z",
  "status": "pass",
  "summary": "0 hard-fail violations across 1 registered rule; 8 advisory findings reviewed and dismissed",
  "stats": { "checksRun": 3, "passed": 3, "failed": 0, "advisory": 8 },
  "findings": [
    {
      "id": "referral-scoring-single-owner:hit-3",
      "severity": "advisory",
      "rule": "referral-scoring-single-owner",
      "message": "Company-name match outside scoringEngine.js -- requires manual review",
      "file": "src/App.jsx",
      "line": 11150,
      "evidence": "const refCon = matchContactsToCompany(j.company, contacts)[0];",
      "requiresManualReview": true,
      "reviewNote": "Consumes engine output (matchContactsToCompany), does not reimplement matching -- not a violation."
    }
  ]
}
```

The Release Candidate Validator's consolidated report is an array of these (one per sub-tool it ran), plus its own top-level `status`/`summary` rolling them up. The ADR Generator reads that array directly to populate an ADR's Evidence section — no re-typing.

## The five tools

### 1. Architecture Validator

**Detects:** duplicate business logic, module-ownership violations, architecture-rule breaches.

**Input:** `tools/config/ownership-rules.json` — a registry of rules, each shaped like:
```json
{
  "id": "referral-scoring-single-owner",
  "description": "Referral matching, scoring, tiering, and ranking must be owned by scoringEngine.js",
  "ownerFile": "src/lib/referralIntelligence/scoringEngine.js",
  "scope": "src/",
  "hardFailPatterns": [
    { "pattern": "b\\.score - a\\.score", "description": "duplicated ranking comparator" }
  ],
  "advisoryPatterns": [
    { "pattern": "c\\.company.*toLowerCase\\(\\).*===.*toLowerCase", "description": "possible duplicated company-matching -- verify manually" }
  ]
}
```
The first registered rule is transcribed directly from `ADR-Referral-Intelligence.md`'s Decision #2 and #6 — dogfooding it immediately, expected to reproduce Phase 9's exact findings (0 hard-fail hits, 8 advisory hits already triaged and recorded as non-violations).

**Behavior:** for each rule, grep `scope` excluding `ownerFile`. A `hardFailPatterns` hit outside the owner is always a real violation (this session's evidence: the ranking-comparator pattern was unambiguous — 1 hit, always inside the owner, would be a certain violation anywhere else). An `advisoryPatterns` hit is reported for human review, not auto-failed — this session's evidence: 8 of 9 company-matching hits were legitimate unrelated code, and distinguishing them required reading context a regex can't see.

**CLI:** `node tools/architecture-validator/index.js [--rule=<id>] [--format=json|md|console]`

### 2. Localization Validator

**Detects:** missing translation keys, hardcoded strings, namespace collisions, accidental modification of existing translations.

**Input:** `tools/config/localization.config.json` — `{ "localesDir": "src/i18n/locales", "sourceLocale": "en", "locales": ["ar","de","es",...] }`.

**Checks** (each independently invokable, matching the four discrete validations actually run in Phase 8):
- **Coverage** — for a given list of new key paths (e.g. `networking.referralIntroTitle`), confirm they exist in every target locale. Direct reuse of the exact logic from this session's `_tmp-check-locale-keys.mjs`.
- **Diff purity** — for a given set of locale files, confirm `git diff` contains zero removed/modified lines (pure additions only), so a translation sweep can't silently corrupt an existing key. Direct reuse of the `git diff --stat` technique from Phase 8.
- **Namespace collision** — for a new key name, confirm no other key in the same top-level namespace already uses that exact name.
- **Hardcoded-string scan** (advisory only, not pass/fail) — heuristic JSX text-node scan for un-translated strings. Documented as heuristic because this session's own version of this check produced false positives (a standalone emoji, a JS expression fragment) that needed a human to dismiss.

**CLI:** `node tools/localization-validator/index.js --keys=<file> --namespace=networking --check=coverage,diff-purity,collision,hardcoded`

### 3. Regression/Test Runner

**Runs:** every registered Playwright verification suite, consolidated into one report.

**Input:** `tools/config/regression-suites.json` — an explicit registry (not a blind glob, so a stale or half-finished script never accidentally runs as if it were a permanent suite):
```json
[
  { "id": "networking-phase2-structural", "path": "scripts/verify/verify-networking-phase2-structural.cjs", "feature": "referral-intelligence" },
  { "id": "referral-intelligence-ui", "path": "scripts/verify/verify-referral-intelligence-phase6.cjs", "feature": "referral-intelligence" },
  { "id": "opportunity-integration", "path": "scripts/verify/verify-opportunity-phase7.cjs", "feature": "referral-intelligence" }
]
```

**Behavior:** runs each registered script as a child process exactly as-is (no modification required), captures stdout and exit code, parses the existing `✅`/`❌` lines each script already prints, and aggregates pass/fail counts per suite. This is full backward compatibility by construction — every script written this session already emits output in this format.

**CLI:** `node tools/regression-runner/index.js [--suite=<id>] [--feature=referral-intelligence] [--parallel]`

### 4. Release Candidate Validator

**Automates:** the entire Phase 9 RC checklist as one command.

**Composes:** `npx vite build`, scoped `npx eslint` against the feature's changed files, the Architecture Validator (rules scoped to `--feature`), the Localization Validator (keys scoped to `--feature`), the Regression Runner (suites scoped to `--feature`), and a generalized responsive-overflow checker (extracted from `verify-referral-intelligence-responsive.cjs`'s `noHorizontalOverflow` helper, made reusable rather than copy-pasted for the next feature).

**Input:** `tools/config/rc-checklist.json` (or `--feature` resolving to a per-feature section) declaring which checks apply and at which scope.

**CLI:** `node tools/rc-validator/index.js --feature=referral-intelligence`

**Output:** one consolidated report (JSON + Markdown) written to `tools/reports/<feature>-rc-<timestamp>.{json,md}`. The Markdown form is deliberately shaped so it can become an ADR's Evidence section directly — closing the loop with tool 5.

### 5. ADR Generator

**Generates:** a standardized ADR with a supporting-evidence section that can never drift from what was actually verified, because it's generated from the RC Validator's own report rather than typed from memory.

**Input:** an RC Validator report (JSON) plus a small decisions file (`docs/architecture/<feature>-decisions.json`) holding the human-authored parts that can't be automated — Context, the numbered Decisions, Consequences, and the Decision Log table. Shape:
```json
{
  "feature": "referral-intelligence",
  "context": "...",
  "decisions": [{ "title": "...", "body": "..." }],
  "consequences": "...",
  "decisionLog": [{ "phase": "...", "decision": "..." }]
}
```

**Behavior:** renders `tools/adr-generator/template.md` with the decisions file's prose sections plus an Evidence section built directly from the RC Validator report's `findings`/`stats`/`summary` fields.

**CLI:** `node tools/adr-generator/index.js --feature=referral-intelligence --rc-report=tools/reports/referral-intelligence-rc-<ts>.json --decisions=docs/architecture/referral-intelligence-decisions.json --out=docs/architecture/ADR-Referral-Intelligence.md`

## What's shared vs. tool-specific

**Shared (`tools/shared/`):** config loading, the report schema and its console/JSON/Markdown renderers, CLI flag parsing, the exit-code convention, repo-root-relative path normalization, and the Supabase session-mock helper (used by the Regression Runner when it needs to run something ad hoc, and available for whatever the next feature's verification scripts need — eliminating the 5x-duplicated ~80-line boilerplate this session actually produced).

**Tool-specific:** the ownership-rules registry contents (Architecture Validator), the locale list and key-diffing algorithm (Localization Validator), the suite registry and output-parsing regex (Regression Runner), the RC checklist composition logic (RC Validator), and the Markdown template plus decisions-file schema (ADR Generator).

## Recommended build order

1. **Shared foundation** (`tools/shared/*`, `tools/toolkit.config.json`) — everything else depends on it. Building `mockSupabaseSession.js` first also immediately pays down the concrete 5x-duplication debt identified above.
2. **Architecture Validator** — self-contained, pure grep, no Playwright dependency. Fastest to build, and immediately dogfoodable against the one rule that already exists in prose (Referral Intelligence's ownership rule) with a known-correct expected result to verify against.
3. **Localization Validator** — also self-contained (Node + git), no Playwright dependency.
4. **Regression/Test Runner** — needs the shared report schema but nothing else; wraps the three existing Referral Intelligence suites unchanged as its first registrations.
5. **Release Candidate Validator** — needs 2, 3, and 4 already working, since it composes all three plus build/lint.
6. **ADR Generator** — needs 5's report shape finalized, since it consumes the RC Validator's output directly as its Evidence source.

## Open questions — resolved 2026-08-22

- **Retroactive registration:** resolved yes. `ownership-rules.json` registers Referral Intelligence's one ownership rule (transcribed verbatim from this doc's own example) and `rc-checklist.json` registers a `referral-intelligence` section — running the Architecture Validator against the live repo reproduced a result consistent with Phase 9's audit approach (one rule, hard-fail/advisory tiers), and additionally surfaced one genuine new hard-fail hit introduced since Phase 9 by later feature work (`src/lib/proactiveJobAlerts/discoveryEngine.js` reimplements the ranking comparator inline instead of calling `rankByScore()`) — reported as a real finding, not fixed as part of this tooling task (out of scope: no product code was touched).
- **`tools/reports/` retention:** resolved: stays gitignored, purely local/reproducible — no change from the original design. A feature's RC report can still be attached to its ADR at sign-off time via `adr-generator --rc-report=<path>` without the intermediate JSON itself needing to be committed.
- **New ambiguities found during implementation** (not anticipated by this doc, resolved with the most conservative, non-inventing option — see `tools/README.md`'s "Known limitations" for detail): the `--feature` scoping token for the Architecture Validator required adding an optional `feature` field to each rule (the doc's own example rule didn't have one); the RC Validator's "scoped eslint against feature's changed files" and "keys scoped to `--feature`" for the Localization Validator both assumed a changed-file/per-feature-key tracking mechanism that doesn't exist anywhere in this repo, so both run at their existing whole-repo scope instead; the "generalized responsive-overflow checker" was extracted as a shared Playwright helper (`tools/shared/responsiveCheck.js`) rather than wired into the RC Validator as its own browser-launching sub-check, since that would have required inventing a new per-feature URL/mock-session config format.
