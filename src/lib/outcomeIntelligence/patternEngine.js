// Deterministic confidence/pattern computation for Application Outcome Intelligence,
// per the locked blueprint's §3 (Learning Engine) and §4 (Pattern System) formulas.
// Pure functions only -- no Supabase, no AI calls. The AI's job is narrative synthesis
// over the structured output of this module (see docs/Application Outcome Intelligence
// Locked Blueprint.md), not computing the numbers itself.
//
// Locked implementation decision: Withdrawn applications are excluded from every
// calculation in this module -- user-initiated, not an employer outcome.

const EXCLUDED_RESPONSE_STATUSES = new Set(["withdrawn"]);
const POSITIVE_STATUSES = new Set(["interview_invited", "offer"]);

export function eligibleApplications(applications) {
  return (applications || []).filter(a => !EXCLUDED_RESPONSE_STATUSES.has(a.responseStatus));
}

// Exported so other modules that read `applications` (e.g. Proactive Job
// Alerts' Timing Intelligence, src/lib/proactiveJobAlerts/marketSignals.js)
// reuse this exact definition of "responded"/"positive outcome" rather than
// re-deriving their own -- Application Outcome Intelligence owns what these
// mean, every consumer imports, never reimplements.
export const hasResponse = (a) => !!a.responseStatus && a.responseStatus !== "pending";
export const isPositiveOutcome = (a) => POSITIVE_STATUSES.has(a.responseStatus);

// 0 -> no analysis at all (null): nothing decided yet, nothing to synthesize. 1-15
// Early Signal. 15-30 Emerging. 30+ High Confidence. The floor moved from 5 to 1
// (2026-08) so a user gets their first AI narrative from their first real hiring
// outcome, not after submitting enough applications to clear a count threshold --
// availability is now data-driven (see the per-analysis predicates below), not
// application-count-driven.
export function computeConfidenceTier(outcomesLoggedCount) {
  if (outcomesLoggedCount < 1) return null;
  if (outcomesLoggedCount < 15) return "early_signal";
  if (outcomesLoggedCount < 30) return "emerging";
  return "high_confidence";
}

// 90-day rolling window, exponential recency weighting (blueprint §3). Half-life of 30
// days is this module's own reasonable interpretation -- the blueprint specifies the
// window and the decay shape but not an exact half-life constant.
function recencyWeight(dateStr, now) {
  if (!dateStr) return 0.5;
  const days = (now - new Date(dateStr)) / 86400000;
  if (days > 90 || days < 0) return days > 90 ? 0 : 0.5;
  return Math.pow(0.5, days / 30);
}

// One bucket = all eligible applications sharing a single pattern-dimension value
// (e.g. company_size = "mid"). Returns null if the bucket is empty.
export function computePatternMetrics(bucketApps, allEligibleCount) {
  if (!bucketApps.length) return null;
  const now = new Date();
  const decided = bucketApps.filter(hasResponse);
  const sampleSize = bucketApps.length;

  let weightedPositive = 0, weightedTotal = 0;
  decided.forEach(a => {
    const w = recencyWeight(a.responseReceivedAt || a.date, now);
    weightedTotal += w;
    if (isPositiveOutcome(a)) weightedPositive += w;
  });
  const responseRate = weightedTotal > 0
    ? weightedPositive / weightedTotal
    : (decided.length ? decided.filter(isPositiveOutcome).length / decided.length : 0);

  // Consistency/stability: split decided applications chronologically in half and
  // compare the positive rate of each half. A large gap between halves means the
  // pattern is trending (changing) or noisy (volatile), not stable.
  const sorted = [...decided].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  const mid = Math.floor(sorted.length / 2);
  const rateOf = (arr) => arr.length ? arr.filter(isPositiveOutcome).length / arr.length : null;
  const rate1 = rateOf(sorted.slice(0, mid));
  const rate2 = rateOf(sorted.slice(mid));
  let stability = "stable";
  if (rate1 != null && rate2 != null) {
    const delta = Math.abs(rate1 - rate2);
    stability = delta > 0.4 ? "volatile" : delta > 0.15 ? "changing" : "stable";
  } else if (sampleSize < 5) {
    stability = "volatile"; // too little data to call it stable
  }

  const direction = responseRate >= 0.5 ? "positive" : responseRate <= 0.15 ? "negative" : "neutral";
  const dataCompleteness = allEligibleCount > 0 ? decided.length / allEligibleCount : 0;

  // Confidence per pattern gates on both sample size AND data completeness -- a large
  // sample with mostly-unlogged outcomes is capped, per blueprint §3's completeness factor.
  let confidence = "early_signal";
  if (sampleSize >= 30 && dataCompleteness >= 0.6) confidence = "high_confidence";
  else if (sampleSize >= 15 && dataCompleteness >= 0.4) confidence = "emerging";

  return {
    response_rate: Math.round(responseRate * 1000) / 1000,
    sample_size: sampleSize,
    direction,
    stability,
    confidence,
    data_completeness: Math.round(dataCompleteness * 1000) / 1000,
  };
}

const PATTERN_DIMENSIONS = [
  { type: "company_size", field: "companySizeEstimate" },
  { type: "industry", field: "industry", normalize: (v) => String(v).trim().toLowerCase() },
  { type: "remote_policy", field: "remotePolicy" },
  { type: "smart_apply", field: "smartApplyUsed", bool: true },
  { type: "cover_letter", field: "coverLetterSent", bool: true },
  { type: "referral", field: "referralUsed", bool: true },
  { type: "resume_version", field: "resumeId" },
];

// Groups eligible applications by each pattern dimension and computes metrics per bucket.
// Output shape matches the outcome_patterns table columns directly (see migration
// 20260801000000_application_outcome_intelligence.sql).
export function computeAllPatterns(applications) {
  const eligible = eligibleApplications(applications);
  const results = [];
  PATTERN_DIMENSIONS.forEach(dim => {
    const buckets = new Map();
    eligible.forEach(a => {
      const raw = a[dim.field];
      if (raw == null || raw === "") return;
      const value = dim.bool ? (raw ? "used" : "not_used") : (dim.normalize ? dim.normalize(raw) : String(raw));
      if (!buckets.has(value)) buckets.set(value, []);
      buckets.get(value).push(a);
    });
    buckets.forEach((bucketApps, value) => {
      const metrics = computePatternMetrics(bucketApps, eligible.length);
      if (metrics) results.push({ pattern_type: dim.type, pattern_value: value, ...metrics });
    });
  });
  return results;
}

// Zone 1 (Funnel Overview) is real data, not AI -- computed directly, always visible
// regardless of confidence tier.
export function computeFunnel(applications) {
  const eligible = eligibleApplications(applications);
  const responded = eligible.filter(hasResponse);
  const interviewed = eligible.filter(a => a.firstInterviewAt || isPositiveOutcome(a));
  const offered = eligible.filter(a => a.responseStatus === "offer");
  return {
    applied: eligible.length,
    responded: responded.length,
    interviewed: interviewed.length,
    offered: offered.length,
    responseRate: eligible.length ? responded.length / eligible.length : 0,
    interviewRate: responded.length ? interviewed.length / responded.length : 0,
    offerRate: interviewed.length ? offered.length / interviewed.length : 0,
  };
}

// Funnel Stage Intelligence (Analysis 02): where in the pipeline rejections cluster.
// Only counts applications with a manually-logged rejection_stage -- this field can't
// be derived, since `status` only holds the current state, not history.
export function computeRejectionStageBreakdown(applications) {
  const eligible = eligibleApplications(applications).filter(a => a.responseStatus === "rejected" && a.rejectionStage);
  const counts = {};
  eligible.forEach(a => { counts[a.rejectionStage] = (counts[a.rejectionStage] || 0) + 1; });
  return { counts, totalLogged: eligible.length };
}

// Per-analysis availability. Each of the blueprint's six fixed analyses becomes
// available the moment ITS OWN specific data requirement is met -- never on a global
// application or outcome count. This is what makes the feature reward real hiring
// progress instead of application volume: a user who gets one interview sees Funnel
// Stage Intelligence; a user who never does but has applied to five different
// industries sees Company Profile Fit -- independently, based only on what each
// analysis actually needs to say something real.
export function computeAnalysisAvailability({ outcomesLoggedCount, funnel, rejectionStages, patterns }) {
  const byType = (type) => patterns.filter(p => p.pattern_type === type);
  const smartApply = byType("smart_apply");
  return {
    // Needs at least one decided outcome to compare responded vs. non-responded.
    responsePattern: outcomesLoggedCount >= 1,
    // Needs pipeline movement beyond "responded": an interview, or a logged rejection
    // stage, either of which gives the stage-by-stage conversion something to show.
    funnelStage: funnel.interviewed >= 1 || rejectionStages.totalLogged >= 1,
    // Any one of the three company-side dimensions (size, industry, remote policy) is
    // enough -- this is one analysis that reads across whichever of its fields exist.
    companyProfileFit: byType("company_size").length > 0 || byType("industry").length > 0 || byType("remote_policy").length > 0,
    // Needs a real comparison: outcomes from BOTH a Smart Apply and a manual
    // application, not just one or the other.
    applicationQuality: smartApply.some(p => p.pattern_value === "used") && smartApply.some(p => p.pattern_value === "not_used"),
    // Needs 2+ distinct resume versions with logged outcomes to compare.
    resumeVersion: byType("resume_version").length >= 2,
    // Synthesis layer -- meaningful as soon as there's anything else to synthesize.
    strategicPrediction: outcomesLoggedCount >= 1,
  };
}

// Count of decided outcomes (Interview/Offer/Rejected/Ghosted -- anything the user has
// recorded that isn't still "pending"). Previously required 14 days of maturity before
// counting ANY decided status, which delayed recognizing an immediate rejection or
// interview by up to two weeks. Removed (2026-08): the Tracker is the source of truth,
// and every one of these statuses is a user-confirmed, unambiguous employer signal the
// moment it's logged -- including Ghosted, which is itself a manual status the user
// only sets after judging enough time has passed, so no additional systemic wait is
// needed on top of that.
export function computeOutcomesLoggedCount(applications) {
  return eligibleApplications(applications).filter(hasResponse).length;
}
