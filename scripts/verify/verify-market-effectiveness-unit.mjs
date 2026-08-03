/**
 * verify-market-effectiveness-unit.mjs — Proactive Job Alerts Phase 3 unit
 * tests for the deterministic precursor modules that feed the AI layer:
 * marketSignals.js (Analysis 03 + 06) and effectivenessMetrics.js (Analysis 05).
 * Pure logic, no Playwright, no dev server.
 *
 * Run: node scripts/verify/verify-market-effectiveness-unit.mjs
 */
import {
  computeVolumeTrend, detectHiringFreeze, computeSalarySignal, computeSpeedOfFill,
  computeApplicationWindowStats, computePersonalOutcomeTiming, computeSeasonalPattern,
} from "../../src/lib/proactiveJobAlerts/marketSignals.js";
import {
  computeAlertTrustScore, findMissedOpportunities, computeOpportunityEngagementTrends,
  computeDiscoveryCoverage, TRUST_SCORE_SELF_CORRECTION_THRESHOLD,
} from "../../src/lib/proactiveJobAlerts/effectivenessMetrics.js";

const results = [];
const check = (label, pass) => { results.push({ label, pass }); console.log(`${pass ? "✅" : "❌"} ${label}`); };
const NOW = new Date("2026-08-03T12:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

// ===== Market Signals =====
console.log("\n=== Volume Trend ===");
{
  check("Rising: +25% vs prior avg", computeVolumeTrend({ currentPeriodCount: 125, priorPeriodAvg: 100 }).trend === "rising");
  check("Declining: -25% vs prior avg", computeVolumeTrend({ currentPeriodCount: 75, priorPeriodAvg: 100 }).trend === "declining");
  check("Flat: within +/-10%", computeVolumeTrend({ currentPeriodCount: 105, priorPeriodAvg: 100 }).trend === "flat");
  check("No prior data -> trend null, not fabricated", computeVolumeTrend({ currentPeriodCount: 50, priorPeriodAvg: null }).trend === null);
}
console.log("\n=== Hiring Freeze Detection ===");
{
  const allDeclining = { eng: { trend: "declining" }, pm: { trend: "declining" }, design: { trend: "declining" } };
  check("Broad slowdown flagged when ALL categories decline", detectHiringFreeze(allDeclining).broadSlowdown === true);
  const oneDeclining = { eng: { trend: "declining" }, pm: { trend: "rising" }, design: { trend: "flat" } };
  check("NOT flagged as broad slowdown when only 1 of 3 categories declines (isolated, not attributed to user fit)", detectHiringFreeze(oneDeclining).broadSlowdown === false);
  check("Single category never flags a broad slowdown (needs >=2 to compare)", detectHiringFreeze({ eng: { trend: "declining" } }).broadSlowdown === false);
}
console.log("\n=== Salary Signal ===");
{
  check("Rising salary signal", computeSalarySignal({ currentAvgSalary: 160000, priorAvgSalary: 150000 }).trend === "rising");
  check("Declining salary signal", computeSalarySignal({ currentAvgSalary: 140000, priorAvgSalary: 150000 }).trend === "declining");
}
console.log("\n=== Speed of Fill ===");
{
  const postings = [
    { postedAt: daysAgo(20), closedAt: daysAgo(5) }, // 15 days
    { postedAt: daysAgo(30), closedAt: daysAgo(20) }, // 10 days
    { postedAt: daysAgo(10) }, // no closedAt -- excluded
  ];
  const r = computeSpeedOfFill(postings);
  check("Speed of fill averages only postings with both dates", r.sampleSize === 2 && r.avgDays === 13);
}

console.log("\n=== Application Window Stats ===");
{
  const applications = [
    { daysSincePosted: 1, responseStatus: "interview_invited" }, { daysSincePosted: 2, responseStatus: "interview_invited" }, { daysSincePosted: 2, responseStatus: "rejected" },
    { daysSincePosted: 15, responseStatus: "rejected" }, { daysSincePosted: 16, responseStatus: "rejected" },
    { daysSincePosted: 30, responseStatus: "pending" }, // no response yet -- excluded from decided
  ];
  const stats = computeApplicationWindowStats(applications);
  const day13 = stats.find(s => s.window === "day_1_3");
  check("day_1_3 bucket has correct sample size", day13.sampleSize === 3);
  check("day_1_3 response rate reflects 2/3 positive outcomes", day13.responseRate === 0.667);
  const week4plus = stats.find(s => s.window === "week_4_plus");
  check("Undecided (still Applied) application excluded from response rate denominator", week4plus.decidedCount === 0 && week4plus.responseRate === null);
}
{
  const timing = computePersonalOutcomeTiming([
    { daysSincePosted: 1, responseStatus: "interview_invited" }, { daysSincePosted: 2, responseStatus: "interview_invited" },
    { daysSincePosted: 25, responseStatus: "rejected" }, { daysSincePosted: 26, responseStatus: "rejected" },
  ]);
  check("Personal timing signal identifies the best-performing window", timing.hasSignal === true && timing.bestWindow === "day_1_3");
}
{
  const timing = computePersonalOutcomeTiming([{ daysSincePosted: 1, responseStatus: "interview_invited" }]);
  check("Insufficient data (only 1 window with data) -> no signal fabricated", timing.hasSignal === false);
}
console.log("\n=== Seasonal Pattern ===");
{
  const monthly = { jan: { trend: "flat" }, feb: { trend: "rising" }, mar: { trend: "declining" } };
  const r = computeSeasonalPattern(monthly);
  check("Identifies rising months", r.risingMonths.includes("feb") && r.risingMonths.length === 1);
  check("Flags a seasonal signal when rising months are a subset, not all/none", r.hasSeasonalSignal === true);
}

// ===== Effectiveness Metrics =====
console.log("\n=== Alert Trust Score ===");
{
  const alerts = [
    { delivered_at: daysAgo(5), engaged_at: daysAgo(4) },
    { delivered_at: daysAgo(10), application_id: "app1" },
    { delivered_at: daysAgo(15) }, // no engagement
    { delivered_at: daysAgo(15) }, // no engagement
    { delivered_at: daysAgo(45) }, // outside 30-day window -- excluded
  ];
  const r = computeAlertTrustScore(alerts, { now: NOW });
  check("Trust score only counts alerts within the 30-day window", r.totalAlerts === 4);
  check("Trust score formula: engaged-or-applied / total", r.trustScore === 0.5);
  check("Below-40% self-correction NOT triggered at exactly 50%", r.needsSelfCorrection === false);
}
{
  const alerts = [{ delivered_at: daysAgo(5) }, { delivered_at: daysAgo(5) }, { delivered_at: daysAgo(5) }, { delivered_at: daysAgo(5) }, { delivered_at: daysAgo(5), engaged_at: daysAgo(4) }];
  const r = computeAlertTrustScore(alerts, { now: NOW });
  check(`Trust score of 20% correctly triggers self-correction (threshold ${TRUST_SCORE_SELF_CORRECTION_THRESHOLD})`, r.trustScore === 0.2 && r.needsSelfCorrection === true);
}
{
  const r = computeAlertTrustScore([], { now: NOW });
  check("No alerts in window -> null score, not zero (avoids implying a bad score with no data)", r.trustScore === null);
}

console.log("\n=== Missed Opportunity Review ===");
{
  const alertCandidates = [
    { id: "cand1", lifecycle_status: "expired" },
    { id: "cand2", lifecycle_status: "expired" },
    { id: "cand3", lifecycle_status: "applied" }, // not missed
    { id: "cand4", lifecycle_status: "expired" }, // never alerted -- not a "missed" alert
  ];
  const alerts = [
    { candidate_id: "cand1" }, // alerted, expired, never engaged -- MISSED
    { candidate_id: "cand2", engaged_at: daysAgo(1) }, // alerted, expired, but engaged -- not missed
    { candidate_id: "cand3", application_id: "app1" },
  ];
  const missed = findMissedOpportunities(alertCandidates, alerts);
  check("Identifies exactly the alerted-expired-unengaged opportunity", missed.length === 1 && missed[0].id === "cand1");
}

console.log("\n=== Personal Opportunity Trends ===");
{
  const alertCandidates = [
    { industry: "fintech", lifecycle_status: "engaged" }, { industry: "fintech", lifecycle_status: "applied" }, { industry: "fintech", lifecycle_status: "alerted" },
    { industry: "healthcare", lifecycle_status: "alerted" }, { industry: "healthcare", lifecycle_status: "alerted" }, { industry: "healthcare", lifecycle_status: "alerted" },
    { industry: "retail", lifecycle_status: "alerted" }, { industry: "retail", lifecycle_status: "engaged" }, // only 2 -- below sample floor
  ];
  const trends = computeOpportunityEngagementTrends(alertCandidates);
  const fintech = trends.find(t => t.dimension === "industry" && t.value === "fintech");
  check("Computes engagement rate per bucket with sufficient sample size", fintech.engagementRate === 0.667);
  const retail = trends.find(t => t.dimension === "industry" && t.value === "retail");
  check("Excludes buckets below the minimum sample size (no fabricated pattern from 2 data points)", retail === undefined);
}

console.log("\n=== Discovery Coverage ===");
{
  const alertCandidates = [
    ...Array(9).fill({ lifecycle_status: "discarded", alert_tier: "discarded" }),
    { lifecycle_status: "alerted", alert_tier: "curated" },
  ];
  const r = computeDiscoveryCoverage(alertCandidates);
  check("Coverage counts total evaluated pool correctly", r.total === 10);
  check("High discard rate correctly flagged (9/10 = 90%)", r.discardRateHigh === true);
  check("Surface rate NOT flagged as high at only 10%", r.surfaceRateHigh === false);
}
{
  const r = computeDiscoveryCoverage([]);
  check("Empty pool produces null rates, not misleading 0%/100%", r.discardRate === null && r.surfaceRate === null);
}

console.log("\n=== SUMMARY ===");
const failed = results.filter(r => !r.pass);
console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED:\n${failed.map(f => "  - " + f.label).join("\n")}`);
process.exit(failed.length === 0 ? 0 : 1);
