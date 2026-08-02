# Backlog: Localization Debt Cleanup

**Status:** Deferred — not scheduled
**Discovered:** 2026-08-02, while validating the new `tools/localization-validator/index.js` against the full app (not scoped to any namespace) as part of confirming the tool worked correctly.
**Discovered by:** Localization Validator's `coverage` check (`node tools/localization-validator/index.js --check=coverage`).

## Context

These gaps are **pre-existing** — none were introduced by, or related to, the Referral Intelligence feature or the Developer Toolkit. They were surfaced incidentally: running the Localization Validator's coverage check without a `--namespace` filter (i.e., across the entire `en.js`) to confirm the tool worked correctly on real data returned 845 missing-key findings. Aggregating those 845 findings by key showed they collapse to **65 unique keys**, each missing from **all 13 non-English locales uniformly** (65 × 13 = 845 exactly) — meaning these are 65 keys that were added to `en.js` at some point but never carried through the translation sweep for any other language, not a partial or inconsistent gap.

Per architect instruction, **not fixed now** — this document exists to record the finding so it isn't lost, not to schedule the work.

## Backlog Items

### 1. Pricing / Checkout flow

**Priority: High** — these are transactional, payment-confirmation messages; a non-English user completing a purchase currently sees raw English for success/failure/verifying states, which is the single most consequential gap in this list (directly touches the billing conversion flow).

- Missing keys: `pricing.checkoutFailed`, `pricing.checkoutSuccess`, `pricing.checkoutVerifying`
- Affected locales: all 13 (ar, de, es, fr, hi, it, ja, ko, nl, pt, ru, tr, zh)
- Where discovered: Localization Validator
- Status: Deferred

### 2. Settings / Subscription management

**Priority: Medium** — account/billing management (cancellation, renewal, trial status, usage limits). Not mid-transaction like item 1, but has retention and clarity implications (e.g. a user not understanding `settings.cancelConfirmBody` in their own language before confirming a cancellation).

- Missing keys: `settings.cancelConfirm`, `settings.cancelConfirmBody`, `settings.cancelConfirmNo`, `settings.cancelConfirmYes`, `settings.cancelSuccess`, `settings.cancelsOn`, `settings.manageSub`, `settings.pastDue`, `settings.renewsOn`, `settings.resumeSub`, `settings.trialActive`, `settings.trialDaysRemaining`, `settings.trialEnds`, `settings.trialExpiredStatus`, `settings.usageFeatureAI`, `settings.usageFeatureInterview`, `settings.usageFeatureResume`, `settings.usageFeatureSalary`, `settings.usageHeading`, `settings.usageUnlimited`, `settings.usageUsedOf`
- Affected locales: all 13
- Where discovered: Localization Validator
- Status: Deferred

### 3. Saved Jobs / Smart Apply prep & job-posting-change detection

**Priority: Medium** — a broad, heavily-used feature surface (document editing, Smart Apply preparation, and the job-posting-change diff UI) entirely untranslated. Functional fallback to English exists (no broken UI), but it's a large visible gap on a core page.

- Missing keys: `savedJobs.analyzingChanges`, `savedJobs.changeAnalysisFailed`, `savedJobs.changeSummaryLabel`, `savedJobs.doneEditing`, `savedJobs.downloadDocxMobile`, `savedJobs.downloadPdfMobile`, `savedJobs.editDocument`, `savedJobs.educationChanged`, `savedJobs.experienceChanged`, `savedJobs.jobChangedDetailUnprepared`, `savedJobs.jobChangedNotice`, `savedJobs.jobDescriptionLabel`, `savedJobs.jobPostingChanges`, `savedJobs.jobPostingChangesIntro`, `savedJobs.newSkillsAdded`, `savedJobs.noDescriptionAvailable`, `savedJobs.otherChanges`, `savedJobs.prepareSmartApply`, `savedJobs.preparingSmartApply`, `savedJobs.responsibilitiesChanged`, `savedJobs.savingEdit`, `savedJobs.skillsRemoved`, `savedJobs.smartApplyHelperText`, `savedJobs.toolsChanged`, `savedJobs.viewJobPosting`, `savedJobs.workAuthorizationChanged`
- Affected locales: all 13
- Where discovered: Localization Validator
- Status: Deferred

### 4. Interview / Voice recording errors & controls

**Priority: Medium** — these are error/troubleshooting messages shown when voice input fails (no mic, permission denied, unsupported browser, etc.). Untranslated error copy is disproportionately confusing precisely when something is already going wrong for the user.

- Missing keys: `interview.voiceErrDefault`, `interview.voiceErrNoMic`, `interview.voiceErrNoSpeech`, `interview.voiceErrPermission`, `interview.voiceErrUnsupported`, `interview.voiceStart`, `interview.voiceStop`
- Affected locales: all 13
- Where discovered: Localization Validator
- Status: Deferred

### 5. Interview / History & discard confirmation

**Priority: Low** — visible but infrequently-encountered labels (past-interviews history modal, a confirmation dialog for discarding an in-progress interview). Cosmetic relative to items 1–4.

- Missing keys: `interview.discardCancel`, `interview.discardConfirm`, `interview.discardConfirmMsg`, `interview.historyModeMock`, `interview.historyModePractice`, `interview.historyModeVoice`, `interview.historyTitle`, `interview.historyUnlabeled`
- Affected locales: all 13
- Where discovered: Localization Validator
- Status: Deferred

## Not part of this backlog

The hardcoded-string heuristic check (`--check=hardcoded`) was not run app-wide as part of this discovery — only key *coverage* was checked. A future pass of that check across the full `src/` tree may surface additional, different gaps (un-translated strings that were never even added as keys to `en.js`) not captured here.
