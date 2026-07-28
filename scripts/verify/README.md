# Verification scripts

Playwright-based engineering verification tools for CareerPersona AI. Each
script is a standalone Node script (no test runner) that boots a headless
(or headed) browser, mocks or hits real backend endpoints as noted below, and
exits non-zero on failure so it can be scripted or run ad hoc.

All scripts use the same auth pattern: a fake-but-structurally-valid Supabase
JWT is injected into `localStorage` via `addInitScript()` before the page
loads, so `getSession()` resolves instantly without a real login. This is a
test convenience, not a security boundary — never point these scripts at
anything containing real user data.

## Scripts

| Script | Purpose | Production-safe? | Requires |
|---|---|---|---|
| [`verify-compatibility-engine.cjs`](verify-compatibility-engine.cjs) | Confirms the Career Compatibility Engine renders a Match % badge with zero Claude calls, and that "AI Match" is fully gone from the UI. | No — fully mocked | Dev server on `:5183` |
| [`verify-downstream-pages.cjs`](verify-downstream-pages.cjs) | Confirms Dashboard, Saved Jobs, and Opportunity Intelligence all still read `match_score` correctly off a saved job. | No — fully mocked | Dev server on `:5185` |
| [`verify-resume-sync.cjs`](verify-resume-sync.cjs) | Confirms Job Search's auto-activated resume matches the one highlighted as active in Resume Library. | No — fully mocked | Dev server on `:5173` |
| [`verify-i18n.mjs`](verify-i18n.mjs) | Loads every page in every supported language, checks for auth-screen leakage and untranslated English text. | No — fully mocked | Dev server on `:5173` |
| [`verify-post-deploy-live.cjs`](verify-post-deploy-live.cjs) | Runs a real job search against the live Cloudflare Worker and live Supabase `skill_synonyms` table. The only script that talks to production infrastructure. | **Partially** — real Worker/Supabase reads, safe to run any time, but not offline | Dev server on `:5180`, and that port must be present in `worker.js`'s `ALLOWED_ORIGINS` |

Each script's own header comment has the authoritative purpose/prerequisites
— this table is a quick-reference index, not a substitute for reading it.

**Port numbers are hardcoded per-script** (leftover from whichever dev server
port was active when each script was written) — if your dev server runs on a
different port, update the `BASE`/URL constant near the top of the script
before running it.

## Recommended order after a deployment

1. `npm run verify:deploy` (`verify-post-deploy-live.cjs`) — confirms the
   deployed Worker and live Supabase data are actually reachable and correct.
   Run this first; if it fails, nothing else matters until it's fixed.
2. `npm run verify:compat` (`verify-compatibility-engine.cjs`) — confirms the
   scoring UI itself is wired correctly (mocked, so isolates frontend logic
   from backend/network issues already covered by step 1).
3. `npm run verify:downstream` (`verify-downstream-pages.cjs`) — confirms
   nothing downstream of a saved job broke.
4. `npm run verify:resume-sync` (`verify-resume-sync.cjs`) — confirms resume
   selection still stays in sync between Job Search and Resume Library.
5. `npm run verify:i18n` (`verify-i18n.mjs`) — slowest (5 languages x 16
   pages), run last or independently after i18n-affecting changes.

## Archived verification scripts

[`archive/`](archive/) holds four older scripts that are **not** part of the
active verification set and have no `npm run verify:*` entry:

- `verify-workflow.cjs`
- `verify-workflow-prod.cjs`
- `verify-smartapply-current.cjs`
- `verify-smartapply-debug.cjs`

All four target the legacy "AI Match" auto-analyze flow and the automatic
Smart Apply pipeline (`autoAnalyzeAll`, `autoSmartApply`, `buildMatchPrompt`).
Both features were removed entirely from `src/App.jsx` when Job Search moved
to the deterministic Career Compatibility Engine — these scripts now click UI
elements and exercise functions that no longer exist, and are not expected to
pass.

They're preserved rather than deleted because they document real historical
investigations (the original AI Match/Smart Apply workflow shape, and a
specific "Smart Apply failed" bug repro) that may be useful reference if a
similar bug resurfaces in the current architecture, or if the git history
around that era needs context a diff alone doesn't give. Each file has an
`ARCHIVED` header comment stating it targets the legacy architecture, is kept
for historical reference only, is not expected to work against the current
Compatibility Engine, and should not be used for current production
verification. `verify-smartapply-current.cjs` is additionally a byte-for-byte
duplicate of `verify-workflow.cjs` (differs only in a stale scratchpad path),
kept as-is rather than deduplicated to avoid rewriting archived history.
