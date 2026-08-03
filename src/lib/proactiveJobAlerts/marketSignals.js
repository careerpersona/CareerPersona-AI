// Proactive Job Alerts -- Market & Timing deterministic precursors. Pure
// functions only, same discipline as discoveryEngine.js and
// outcomeIntelligence/patternEngine.js -- no AI calls, no Supabase.
//
// Feeds Analysis 03 (Market Intelligence) and Analysis 06 (Timing
// Intelligence): every number these two analyses narrate is computed here
// first. The AI layer (src/data/proactiveJobAlerts.js) never derives a trend,
// average, or bucket itself -- it only receives these already-computed facts
// and is instructed to interpret them, per the locked "facts in code, AI
// interprets" pattern (Outcome Intelligence, Referral Intelligence).
//
// This is a sibling deterministic engine to discoveryEngine.js, not part of
// it -- Discovery Engine's locked ownership (source aggregation, profile
// matching, signal enrichment, tier assignment, constraint filtering,
// candidate selection) is per-opportunity; market/timing signals are
// aggregate, cross-opportunity statistics, a distinct concern with its own
// file, exactly how patternEngine.js and scoringEngine.js are separate
// engines under the same discipline rather than one growing file.

// Application Outcome Intelligence (patternEngine.js) owns the definition of
// "responded"/"positive outcome" -- imported here, never re-derived, so a
// change to what counts as a response only ever needs to happen in one place.
import { hasResponse, isPositiveOutcome } from "../outcomeIntelligence/patternEngine.js";

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// ── Market Intelligence (§12) precursors ─────────────────────────────────────

// Volume Trend: is posting volume for the user's target roles rising, flat,
// or declining vs. the prior 4-week average?
export function computeVolumeTrend({ currentPeriodCount, priorPeriodAvg }) {
  if (priorPeriodAvg == null || priorPeriodAvg === 0) {
    return { current: currentPeriodCount, previous: priorPeriodAvg ?? null, trend: null, changeRatio: null };
  }
  const changeRatio = round3((currentPeriodCount - priorPeriodAvg) / priorPeriodAvg);
  const trend = changeRatio > 0.1 ? "rising" : changeRatio < -0.1 ? "declining" : "flat";
  return { current: currentPeriodCount, previous: priorPeriodAvg, trend, changeRatio };
}

// Hiring Freeze Detection: flagged only when decline is broad-based across
// ALL role-type categories the user has been evaluated against, never
// attributed to the user's fit from a single-category decline.
export function detectHiringFreeze(volumeTrendsByCategory) {
  const categories = Object.entries(volumeTrendsByCategory || {});
  if (categories.length < 2) return { broadSlowdown: false, categoriesDeclining: 0, categoriesTotal: categories.length };
  const declining = categories.filter(([, t]) => t.trend === "declining");
  return {
    broadSlowdown: declining.length === categories.length,
    categoriesDeclining: declining.length,
    categoriesTotal: categories.length,
  };
}

// Salary Signal: average posted salary ranges for target roles vs. 90-day trend.
export function computeSalarySignal({ currentAvgSalary, priorAvgSalary }) {
  if (currentAvgSalary == null || priorAvgSalary == null || priorAvgSalary === 0) {
    return { current: currentAvgSalary ?? null, previous: priorAvgSalary ?? null, trend: null, changeRatio: null };
  }
  const changeRatio = round3((currentAvgSalary - priorAvgSalary) / priorAvgSalary);
  const trend = changeRatio > 0.05 ? "rising" : changeRatio < -0.05 ? "declining" : "flat";
  return { current: currentAvgSalary, previous: priorAvgSalary, trend, changeRatio };
}

// Speed of Fill: estimated posting-to-close duration, aggregate observation
// across the user's target category.
export function computeSpeedOfFill(postingsWithDates) {
  const durations = (postingsWithDates || [])
    .filter(p => p.postedAt && p.closedAt)
    .map(p => (new Date(p.closedAt) - new Date(p.postedAt)) / 86400000)
    .filter(d => d > 0 && d < 365);
  if (!durations.length) return { avgDays: null, sampleSize: 0 };
  const avgDays = Math.round(durations.reduce((s, d) => s + d, 0) / durations.length);
  return { avgDays, sampleSize: durations.length };
}

// ── Timing Intelligence (§15) precursors ─────────────────────────────────────

const WINDOW_BUCKETS = [
  { key: "day_1_3", min: 0, max: 3 },
  { key: "week_2_3", min: 4, max: 21 },
  { key: "week_4_plus", min: 22, max: Infinity },
];

// Application Window Optimization: does applying earlier or later in a
// posting's lifecycle correlate with better outcomes, for THIS user's own
// logged applications? (Population-level equivalents are out of scope here --
// no cross-user data exists in this app; this is deliberately personal-only,
// consistent with how every other Intelligence feature in this app only ever
// reasons over the current user's own data.)
export function computeApplicationWindowStats(applications) {
  const withTiming = (applications || []).filter(a => a.daysSincePosted != null && a.daysSincePosted >= 0);
  return WINDOW_BUCKETS.map(bucket => {
    const bucketApps = withTiming.filter(a => a.daysSincePosted >= bucket.min && a.daysSincePosted <= bucket.max);
    const decided = bucketApps.filter(hasResponse);
    const responseRate = decided.length ? decided.filter(isPositiveOutcome).length / decided.length : null;
    return { window: bucket.key, sampleSize: bucketApps.length, decidedCount: decided.length, responseRate: responseRate != null ? round3(responseRate) : null };
  });
}

// Personal Outcome Timing: pulled from Application Outcome Intelligence's own
// data (applications), not re-derived pattern math -- reuses the exact same
// isPositiveOutcome/hasResponse eligibility concept patternEngine.js uses,
// bucketed by timing instead of by company_size/industry/etc.
export function computePersonalOutcomeTiming(applications) {
  const stats = computeApplicationWindowStats(applications);
  const withData = stats.filter(s => s.responseRate != null);
  if (withData.length < 2) return { hasSignal: false, bestWindow: null, stats };
  const best = [...withData].sort((a, b) => b.responseRate - a.responseRate)[0];
  return { hasSignal: true, bestWindow: best.window, bestResponseRate: best.responseRate, stats };
}

// Seasonal Hiring Patterns: reuses computeVolumeTrend's category output --
// this function only asks "of the months/quarters we have volume data for,
// which showed a rising trend," it does not recompute volume itself.
export function computeSeasonalPattern(monthlyVolumeTrends) {
  const entries = Object.entries(monthlyVolumeTrends || {});
  const rising = entries.filter(([, t]) => t.trend === "rising").map(([month]) => month);
  return { risingMonths: rising, hasSeasonalSignal: rising.length > 0 && rising.length < entries.length };
}
