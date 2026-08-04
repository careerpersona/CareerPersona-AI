// Shared platform infrastructure -- AI Budget Manager. Pure functions only,
// no Supabase import, no framework dependency -- consumed by worker.js
// (server-side, where the actual quota RPC call must happen -- see the
// Phase 1 verification note below) and safe to import from anywhere else
// that only needs the period-key/combination logic.
//
// Per the locked blueprint (docs/Smart Apply Auto Prep Blueprint.md §11):
// this module owns automation-budget mechanics (period keys, dual-cap
// combination) for ANY automation-capable feature, not just Smart Apply Auto
// Prep. A future feature (e.g. Real-Time Interview Co-Pilot) reuses these
// same helpers with its own feature key and its own cap numbers -- this
// module never encodes feature-specific caps or semantics itself.
//
// Phase 1 verification (resolved): the blueprint flagged an open question --
// does the existing check_and_consume_quota RPC accept an arbitrary period
// key, or is it hardcoded to monthly semantics? Confirmed by reading the RPC
// definition directly (supabase/migrations/20260722000005_billing_quota_rpc.sql):
// `p_period` is a plain text parameter with no format assumption -- reusable
// for a daily key exactly as this module does, no RPC changes needed.
//
// Second finding, not anticipated in the blueprint: the RPC is granted to
// service_role only (`REVOKE ... FROM PUBLIC; GRANT ... TO service_role;`),
// specifically so a client can't spoof p_user_id. This means the actual
// budget CHECK (checkAndConsumeAutomationBudget) can only be called from
// worker.js (service-role context), never directly from the browser --
// consistent with, and reinforcing, the blueprint's own workflow order
// (preparation happens before "the user opens CareerPersona," which already
// implied server-side execution). getAutomationPreference/setAutomationPreference
// are unaffected -- automation_preferences' RLS policy lets a user manage
// their own row directly, so those stay client-callable (src/data/automationPreferences.js).

export function getDailyPeriodKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // "2026-08-06"
}

export function getMonthlyPeriodKey(date = new Date()) {
  return date.toISOString().slice(0, 7); // "2026-08"
}

// Combines the two independent RPC results (one daily-keyed, one
// monthly-keyed) into a single decision. Both must allow for the budget to
// be granted -- either cap failing is sufficient to deny, and the specific
// reason is preserved so the caller can show the real cause (§8 of the
// blueprint: plain language, e.g. "this month's limit is reached," never
// exposed as raw boundary jargon).
export function combineBudgetResults(dailyResult, monthlyResult) {
  if (!dailyResult?.allowed) return { allowed: false, reason: "daily_cap" };
  if (!monthlyResult?.allowed) return { allowed: false, reason: "monthly_cap" };
  return { allowed: true, reason: null };
}
