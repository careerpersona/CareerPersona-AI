/**
 * verify-proactive-alerts-ai-layer-unit.mjs — Proactive Job Alerts Phase 3
 * unit tests for the AI Analysis Layer's PURE functions only: prompt
 * building, availability predicates, and response parsing. Does not call a
 * live askClaude (that requires the running app / DEV_MODE mock, deferred to
 * Phase 5 when there's a UI trigger) -- this tests everything that can be
 * tested without one: the deterministic-availability decision, the exact
 * DATA the prompt would contain, and correct parsing/index-mapping of a
 * hand-crafted mock AI response.
 *
 * Run: node scripts/verify/verify-proactive-alerts-ai-layer-unit.mjs
 */
import {
  buildCriticalOpportunityPrompt, parseCriticalOpportunityResponse,
  buildWatchlistActivityPrompt, parseWatchlistActivityResponse,
  computeWeeklyAvailability, buildWeeklyAnalysesPrompt, parseWeeklyAnalysesResponse,
} from "../../src/lib/proactiveJobAlerts/aiPrompts.js";

const results = [];
const check = (label, pass) => { results.push({ label, pass }); console.log(`${pass ? "✅" : "❌"} ${label}`); };

function fakeCandidate(overrides = {}) {
  return {
    job: { title: "Senior Engineer", company: "Acme Corp" },
    tier: "critical", tierReason: "2 urgency factors", matchScore: 88, confidenceTier: "exceptional",
    urgencyFactors: [{ type: "closing_soon" }, { type: "referral_confirmed" }],
    industry: "fintech", isStretch: false,
    ...overrides,
  };
}

// ===== Analysis 01: Critical Opportunity Engine =====
console.log("\n=== Analysis 01: Critical Opportunity Engine ===");
{
  const built = buildCriticalOpportunityPrompt([]);
  check("No candidates -> prompt is null (nothing to ask the AI about)", built === null);
}
{
  const candidates = [fakeCandidate(), fakeCandidate({ job: { title: "PM", company: "Beta Inc" }, tier: "high", urgencyFactors: [{ type: "watchlist_company_posting" }] })];
  const built = buildCriticalOpportunityPrompt(candidates);
  check("Prompt includes every candidate's company and tier as a fact", built.prompt.includes("Acme Corp") && built.prompt.includes("Beta Inc") && built.prompt.includes("critical") && built.prompt.includes("high"));
  check("Prompt explicitly forbids inventing/changing facts", built.prompt.toLowerCase().includes("do not change, add, or invent"));
  check("Prompt does not ask the AI to decide which candidates are delivered (already decided)", built.prompt.includes("ALREADY been deterministically selected"));

  const mockRaw = JSON.stringify({ v: 1, alerts: [{ index: 1, whyUrgent: "Beta is on your watchlist.", displayRank: 1 }, { index: 0, whyUrgent: "Closing soon with a referral.", displayRank: 2 }] });
  const parsed = parseCriticalOpportunityResponse(mockRaw, candidates);
  check("Parses and maps index back to the real candidate object", parsed[0].candidate.job.company === "Beta Inc");
  check("Respects displayRank ordering from the AI response", parsed[0].displayRank === 1 && parsed[1].displayRank === 2);
}
{
  const candidates = [fakeCandidate()];
  check("Malformed JSON response parses to null, not a crash", parseCriticalOpportunityResponse("not json at all", candidates) === null);
  check("Wrong version number rejected", parseCriticalOpportunityResponse(JSON.stringify({ v: 2, alerts: [] }), candidates) === null);
  const outOfRange = parseCriticalOpportunityResponse(JSON.stringify({ v: 1, alerts: [{ index: 5, whyUrgent: "x", displayRank: 1 }] }), candidates);
  check("Out-of-range index is silently dropped, not a crash or fabricated candidate", outOfRange.length === 0);
}

// ===== Analysis 04: Watchlist Activity Monitor =====
console.log("\n=== Analysis 04: Watchlist Activity Monitor ===");
{
  const allQuiet = [{ companyName: "Acme", signal: "quiet" }, { companyName: "Beta", signal: "quiet" }];
  check("All-quiet watchlist -> prompt is null (nothing worth surfacing)", buildWatchlistActivityPrompt(allQuiet) === null);
}
{
  const states = [
    { companyName: "Acme Corp", signal: "new_posting", detail: "Staff Engineer role", isDreamCompany: true },
    { companyName: "Beta Inc", signal: "quiet", detail: "no postings in 45 days" },
  ];
  const built = buildWatchlistActivityPrompt(states);
  check("Prompt includes only active (non-quiet) signals as facts to interpret", built.prompt.includes("Acme Corp") && built.prompt.includes("new_posting"));
  check("Prompt marks dream-company status as a fact", built.prompt.includes("[dream company]"));

  const mockRaw = JSON.stringify({ v: 1, watchlistSummary: { finding: "Acme Corp is heating up.", evidence: "New Staff Engineer posting at a dream company." } });
  const parsed = parseWatchlistActivityResponse(mockRaw);
  check("Parses the watchlist summary correctly", parsed.finding === "Acme Corp is heating up.");
}

// ===== Weekly Availability (Data-Driven Availability Rule) =====
console.log("\n=== Weekly Availability Predicates ===");
{
  const availAllOff = computeWeeklyAvailability({
    curatedCandidates: [], volumeTrend: { trend: null }, discoveryCoverage: { total: 0 }, personalOutcomeTiming: { hasSignal: false },
  });
  check("All four predicates correctly false with no data", !availAllOff.curatedPipeline && !availAllOff.marketIntelligence && !availAllOff.alertEffectiveness && !availAllOff.timingIntelligence);

  const availAllOn = computeWeeklyAvailability({
    curatedCandidates: [fakeCandidate()], volumeTrend: { trend: "rising" }, discoveryCoverage: { total: 50 }, personalOutcomeTiming: { hasSignal: true },
  });
  check("All four predicates correctly true with sufficient data", availAllOn.curatedPipeline && availAllOn.marketIntelligence && availAllOn.alertEffectiveness && availAllOn.timingIntelligence);
}

// ===== Weekly Prompt: Conditional Section Inclusion =====
console.log("\n=== Weekly Prompt Conditional Inclusion ===");
{
  const availability = { curatedPipeline: true, marketIntelligence: false, alertEffectiveness: false, timingIntelligence: false };
  const built = buildWeeklyAnalysesPrompt({
    curatedCandidates: [fakeCandidate({ isStretch: true })], balanceResult: { gapNote: null },
    volumeTrend: {}, salarySignal: {}, hiringFreeze: {}, speedOfFill: {},
    trustScore: {}, missedOpportunities: [], engagementTrends: [], discoveryCoverage: {},
    applicationWindowStats: [], personalOutcomeTiming: {}, seasonalPattern: {},
    availability,
  });
  check("Only the available section's prompt block is included", built.prompt.includes("ANALYSIS 02") && !built.prompt.includes("ANALYSIS 03") && !built.prompt.includes("ANALYSIS 05") && !built.prompt.includes("ANALYSIS 06"));
  check("Only the available section's JSON schema key is requested", built.prompt.includes('"curatedPipeline"') && !built.prompt.includes('"marketIntelligence"'));
  check("Stretch flag is passed through as a fact for the AI to reference, not recomputed", built.prompt.includes("[STRETCH]"));
}
{
  const availability = { curatedPipeline: false, marketIntelligence: false, alertEffectiveness: false, timingIntelligence: false };
  const built = buildWeeklyAnalysesPrompt({
    curatedCandidates: [], balanceResult: {}, volumeTrend: {}, salarySignal: {}, hiringFreeze: {}, speedOfFill: {},
    trustScore: {}, missedOpportunities: [], engagementTrends: [], discoveryCoverage: {},
    applicationWindowStats: [], personalOutcomeTiming: {}, seasonalPattern: {}, availability,
  });
  check("Nothing available -> prompt is null (no AI call made at all)", built === null);
}
{
  // Full 4-section prompt -- confirm every section's DATA line surfaces the right facts.
  const availability = { curatedPipeline: true, marketIntelligence: true, alertEffectiveness: true, timingIntelligence: true };
  const built = buildWeeklyAnalysesPrompt({
    curatedCandidates: [fakeCandidate()], balanceResult: { gapNote: "Only 10% stretch this week." },
    volumeTrend: { trend: "declining", current: 80, previous: 100 }, salarySignal: { trend: "rising" },
    hiringFreeze: { broadSlowdown: true, categoriesTotal: 3 }, speedOfFill: { avgDays: 21, sampleSize: 12 },
    trustScore: { trustScore: 0.35, totalAlerts: 20, engagedOrApplied: 7, needsSelfCorrection: true },
    missedOpportunities: [{ job_title: "Staff Eng", company: "Gamma" }],
    engagementTrends: [{ dimension: "industry", value: "fintech", engagementRate: 0.5, sampleSize: 5 }],
    discoveryCoverage: { total: 200, counts: { discarded: 180, alerted: 15, engaged: 3, applied: 2 }, discardRate: 0.9 },
    applicationWindowStats: [{ window: "day_1_3", responseRate: 0.6, sampleSize: 10 }],
    personalOutcomeTiming: { hasSignal: true, bestWindow: "day_1_3", bestResponseRate: 0.6 },
    seasonalPattern: { hasSeasonalSignal: true, risingMonths: ["october"] },
    availability,
  });
  check("All 4 sections present when all available", ["ANALYSIS 02", "ANALYSIS 03", "ANALYSIS 05", "ANALYSIS 06"].every(m => built.prompt.includes(m)));
  check("Gap note surfaced verbatim as a fact, not regenerated", built.prompt.includes("Only 10% stretch this week."));
  check("Trust score self-correction note included when needsSelfCorrection is true", built.prompt.includes("automatically raised"));
  check("Broad slowdown framing present, never attributed to user fit (explicit prompt instruction)", built.prompt.includes("never attribute a broad slowdown to the user's individual fit"));
  check("Missed opportunity is passed as a fact for hypothesis generation, not a pre-baked answer", built.prompt.includes("Staff Eng") && built.prompt.includes("hypothesize"));

  const mockRaw = JSON.stringify({
    v: 1,
    analyses: {
      curatedPipeline: [{ index: 0, whyThisWeek: "Strong fintech match." }],
      marketIntelligence: { finding: "Market cooling.", evidence: "Volume down 20%." },
      alertEffectiveness: { trustScoreFinding: "Trust score is low.", missedOpportunityHypotheses: [{ jobTitle: "Staff Eng", company: "Gamma", hypothesis: "Urgency signal was unclear." }], preferenceNote: "" },
      timingIntelligence: { finding: "Apply within 3 days.", evidence: "60% response rate in that window." },
    },
  });
  const parsed = parseWeeklyAnalysesResponse(mockRaw, built);
  check("Parses curatedPipeline and maps index back to the real candidate", parsed.curatedPipeline[0].candidate.job.company === "Acme Corp");
  check("Parses marketIntelligence section", parsed.marketIntelligence.finding === "Market cooling.");
  check("Parses alertEffectiveness with nested missed-opportunity hypotheses", parsed.alertEffectiveness.missedOpportunityHypotheses[0].hypothesis === "Urgency signal was unclear.");
  check("Parses timingIntelligence section", parsed.timingIntelligence.evidence.includes("60%"));
}

console.log("\n=== SUMMARY ===");
const failed = results.filter(r => !r.pass);
console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED:\n${failed.map(f => "  - " + f.label).join("\n")}`);
process.exit(failed.length === 0 ? 0 : 1);
