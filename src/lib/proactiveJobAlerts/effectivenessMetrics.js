// Proactive Job Alerts -- Alert Effectiveness deterministic precursors (feeds
// Analysis 05's four sub-analyses). Pure functions only, no AI, no Supabase.
// Sibling engine to discoveryEngine.js and marketSignals.js -- see
// marketSignals.js's header for why these live in their own file rather than
// growing Discovery Engine's locked ownership list.
//
// Every metric here is a plain count, ratio, or bucketed aggregate -- exactly
// the kind of fact the "AI only interprets, never computes" rule requires be
// computed in code first.

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// ── Sub-Analysis A: Alert Trust Score ────────────────────────────────────────
// Formula given explicitly in the locked blueprint (§14): (alerts that led to
// application or save) / (total alerts sent), rolling 30 days. Below 40%
// triggers an automatic confidence-floor raise -- also deterministic, not an
// AI decision.
export const TRUST_SCORE_SELF_CORRECTION_THRESHOLD = 0.4;

export function computeAlertTrustScore(alerts, { now = new Date(), windowDays = 30 } = {}) {
  const cutoff = new Date(now.getTime() - windowDays * 86400000);
  const windowAlerts = (alerts || []).filter(a => a.delivered_at && new Date(a.delivered_at) >= cutoff);
  if (!windowAlerts.length) return { trustScore: null, totalAlerts: 0, engagedOrApplied: 0, needsSelfCorrection: false };
  const engagedOrApplied = windowAlerts.filter(a => a.engaged_at || a.application_id).length;
  const trustScore = round3(engagedOrApplied / windowAlerts.length);
  return {
    trustScore,
    totalAlerts: windowAlerts.length,
    engagedOrApplied,
    needsSelfCorrection: trustScore < TRUST_SCORE_SELF_CORRECTION_THRESHOLD,
  };
}

// ── Sub-Analysis B: Missed Opportunity Review ────────────────────────────────
// Detection (which alerted opportunities expired without the user applying)
// is a mechanical lifecycle_status/date query -- deterministic. Diagnosing
// WHY a specific one was missed (timing? confidence score too high? unclear
// urgency signal?) has no formula and is left to the AI layer; this function
// only supplies the candidate list, never a guess at the cause.
export function findMissedOpportunities(alertCandidates, alerts) {
  const alertedIds = new Set((alerts || []).map(a => a.candidate_id));
  return (alertCandidates || []).filter(c =>
    c.lifecycle_status === "expired" &&
    alertedIds.has(c.id) &&
    !(alerts || []).some(a => a.candidate_id === c.id && (a.engaged_at || a.application_id))
  );
}

// ── Sub-Analysis C: Personal Opportunity Trends ──────────────────────────────
// Engagement rate by category -- same bucket-and-measure shape as Outcome
// Intelligence's computeAllPatterns, applied to alert engagement instead of
// application outcomes. Reused pattern, not reused code (different source
// table, different eligibility rule), so a parallel implementation here is
// not a duplicate of patternEngine.js's own function.
const ENGAGEMENT_DIMENSIONS = [
  { type: "industry", field: "industry", normalize: v => String(v).trim().toLowerCase() },
  { type: "company_size", field: "companySizeEstimate", normalize: v => String(v).trim().toLowerCase() },
  { type: "alert_tier", field: "tier" },
];

export function computeOpportunityEngagementTrends(alertCandidates) {
  const results = [];
  ENGAGEMENT_DIMENSIONS.forEach(dim => {
    const buckets = new Map();
    (alertCandidates || []).forEach(c => {
      const raw = c[dim.field];
      if (raw == null || raw === "") return;
      if (c.lifecycle_status !== "alerted" && c.lifecycle_status !== "engaged" && c.lifecycle_status !== "applied" && c.lifecycle_status !== "expired") return;
      const value = dim.normalize ? dim.normalize(raw) : String(raw);
      if (!buckets.has(value)) buckets.set(value, []);
      buckets.get(value).push(c);
    });
    buckets.forEach((bucketCandidates, value) => {
      if (bucketCandidates.length < 3) return; // too little data to call it a revealed preference
      const engaged = bucketCandidates.filter(c => ["engaged", "applied"].includes(c.lifecycle_status)).length;
      results.push({
        dimension: dim.type,
        value,
        sampleSize: bucketCandidates.length,
        engagementRate: round3(engaged / bucketCandidates.length),
      });
    });
  });
  return results;
}

// ── Sub-Analysis D: Discovery Coverage ───────────────────────────────────────
// Plain counts by lifecycle_status. The "unusually high discard/surface
// rate" flags are deterministic threshold checks -- what to DO about an
// anomaly (which is left to the AI layer) is a different question from
// whether one exists (answered here).
const HIGH_DISCARD_RATE_THRESHOLD = 0.9;
const HIGH_SURFACE_RATE_THRESHOLD = 0.5;

export function computeDiscoveryCoverage(alertCandidates) {
  const all = alertCandidates || [];
  const total = all.length;
  const counts = { discovered: 0, evaluated: 0, alerted: 0, engaged: 0, applied: 0, expired: 0, discarded: 0 };
  all.forEach(c => {
    if (c.alert_tier === "discarded") counts.discarded++;
    if (counts[c.lifecycle_status] !== undefined) counts[c.lifecycle_status]++;
  });
  const evaluatedTotal = total - counts.discovered;
  const discardRate = evaluatedTotal > 0 ? round3(counts.discarded / evaluatedTotal) : null;
  const surfacedCount = counts.alerted + counts.engaged + counts.applied;
  const surfaceRate = evaluatedTotal > 0 ? round3(surfacedCount / evaluatedTotal) : null;
  return {
    total,
    counts,
    discardRate,
    surfaceRate,
    discardRateHigh: discardRate != null && discardRate >= HIGH_DISCARD_RATE_THRESHOLD,
    surfaceRateHigh: surfaceRate != null && surfaceRate >= HIGH_SURFACE_RATE_THRESHOLD,
  };
}
