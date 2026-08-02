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

const hasResponse = (a) => !!a.responseStatus && a.responseStatus !== "pending";
const isPositiveOutcome = (a) => POSITIVE_STATUSES.has(a.responseStatus);

// Under 5 -> no analysis at all (null). 5-15 Early Signal. 15-30 Emerging. 30+ High Confidence.
export function computeConfidenceTier(outcomesLoggedCount) {
  if (outcomesLoggedCount < 5) return null;
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

// Data completeness gate for the overall analysis run: outcomes logged (decided, i.e.
// not still "pending") among applications old enough to plausibly have heard back.
export function computeOutcomesLoggedCount(applications) {
  const eligible = eligibleApplications(applications);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000);
  const matureApps = eligible.filter(a => !a.date || new Date(a.date) <= fourteenDaysAgo);
  return matureApps.filter(hasResponse).length;
}
