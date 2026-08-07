# Archived: Real-Time Interview Co-Pilot

This directory holds engineering artifacts from the Real-Time Interview Co-Pilot feature (Premium Feature #6), which was **withdrawn before release as a final product decision** — not removed due to a technical, architectural, or testing failure. See `docs/architecture/ADR-Real-Time-Interview-Copilot.md` for the full record and `docs/architecture/Architecture-Governance-Retrospective.md` for the governance lesson this decision produced.

**Why this is archived rather than deleted:** the UI test (`verify-interview-copilot-ui.cjs`) is not runnable against the current application — the feature it tests no longer exists in the UI. It's kept as a reference for how single-tap-trigger, proactive-cap-warning, and cap-reached UX were verified, in case a future interview-assistance feature (built on a different technical foundation — see the ADR's feasibility analysis) needs a similar testing pattern.

**Not registered in `tools/config/regression-suites.json`** — it will not run as part of the regression suite and should not be re-registered without first confirming the feature it tests actually exists again.
