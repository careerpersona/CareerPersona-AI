// Smart Apply Auto Prep -- Qualification and Selection. Pure functions only,
// no Supabase, no AI calls -- same discipline as every other deterministic
// engine in this codebase.
//
// Per the locked blueprint (docs/Smart Apply Auto Prep Blueprint.md §3/§4):
// this module owns NOTHING beyond deciding, from already-computed facts,
// which jobs qualify for automatic preparation and in what order. It never
// computes a score, a gate, or a confidence tier itself -- those remain
// permanently owned by the Career Compatibility Engine
// (src/lib/compatibility/), imported here and never reimplemented. This
// module also introduces no ranking logic beyond a stable sort of the
// Compatibility Engine's own match_score -- no behavioral inference, no
// preference learning, no second scoring formula.

// Qualification (§3) -- a closed input list: Match Score, Eligibility Gates,
// Confidence Tier. Nothing else. `record` is a buildCompatibilityRecord()
// output ({ match_score, confidence, gates, ... }).
export function isJobQualifiedForAutoPrep(record) {
  if (!record) return false;
  const gatesPassed = Array.isArray(record.gates) && record.gates.every(g => g.passed);
  return gatesPassed && record.confidence === "High";
}

// Selection (§4) -- preparation order is entirely determined by match_score,
// descending. Random selection and FIFO (discovery-order) selection are both
// prohibited by the blueprint; this is the one and only ordering rule.
// `entries` is an array of { job, compatibility } pairs (compatibility =
// a buildCompatibilityRecord() output for that job). `budget` is the number
// of slots remaining (already the smaller of daily/monthly remaining,
// decided by the caller -- this function has no budget opinion of its own).
export function selectJobsForAutoPrep(entries, budget) {
  if (!Array.isArray(entries) || !budget || budget <= 0) return [];

  const qualified = entries.filter(e => isJobQualifiedForAutoPrep(e?.compatibility));

  const sorted = [...qualified].sort((a, b) => {
    const scoreDiff = (b.compatibility.match_score ?? 0) - (a.compatibility.match_score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    // Deterministic tie-break: confidence tier already both "High" (qualification
    // requires it), so fall back to job id for a stable, reproducible order --
    // never random, never insertion-order-dependent.
    return String(a.job?.id ?? "").localeCompare(String(b.job?.id ?? ""));
  });

  return sorted.slice(0, budget);
}
