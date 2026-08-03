/**
 * verify-discovery-engine-unit.mjs — Proactive Job Alerts Phase 2 unit tests.
 * Pure logic, no Playwright, no Supabase, no dev server -- exercises every
 * exported function in src/lib/proactiveJobAlerts/discoveryEngine.js against
 * representative inputs, mirroring the rigor applied to scoringEngine.js.
 *
 * Run: node scripts/verify/verify-discovery-engine-unit.mjs
 */
import {
  deduplicateOpportunities,
  filterAlreadyApplied,
  evaluateProfileMatch,
  computeSignalEnrichment,
  computeUrgencyFactors,
  computeConfidenceTier,
  assignAlertTier,
  isStretchOpportunity,
  applyDiversityConstraint,
  applyBalanceConstraint,
  enforceDeliveryCaps,
  evaluateOpportunity,
  CONFIDENCE_FLOOR,
  DAILY_CRITICAL_CAP,
  DAILY_HIGH_CAP,
} from "../../src/lib/proactiveJobAlerts/discoveryEngine.js";

const results = [];
const check = (label, pass) => { results.push({ label, pass }); console.log(`${pass ? "✅" : "❌"} ${label}`); };

const NOW = new Date("2026-08-03T12:00:00Z");
const hoursFromNow = (h) => new Date(NOW.getTime() + h * 3600000).toISOString().split("T")[0];

// ===== Source Aggregation =====
console.log("\n=== Source Aggregation ===");
{
  const postings = [
    { id: "a1", company: "Acme", title: "Engineer" },
    { id: "a1", company: "Acme", title: "Engineer" }, // exact ID dupe
    { id: "a2", company: "Acme", title: "Engineer" }, // fingerprint dupe (different ID)
    { id: "a3", company: "Beta", title: "Engineer" },
    { company: "NoId", title: "Missing ID" }, // no id -- dropped
  ];
  const deduped = deduplicateOpportunities(postings);
  check("Dedupes by exact ID", deduped.filter(j => j.id === "a1").length === 1);
  check("Dedupes by company+title fingerprint across different IDs", !deduped.some(j => j.id === "a2"));
  check("Keeps distinct company+title", deduped.some(j => j.id === "a3"));
  check("Drops postings with no ID", !deduped.some(j => j.title === "Missing ID"));
  check("Final count is 2 (a1, a3)", deduped.length === 2);
}
{
  const postings = [{ id: "x1" }, { id: "x2" }, { id: "x3" }];
  const filtered = filterAlreadyApplied(postings, ["x2"]);
  check("filterAlreadyApplied removes exactly the applied job", filtered.length === 2 && !filtered.some(p => p.id === "x2"));
}

// ===== Profile Matching (delegation sanity) =====
console.log("\n=== Profile Matching ===");
{
  const job = { title: "Senior Engineer", skills: ["React", "TypeScript"], salaryMin: 140000, location: "Austin, TX" };
  const profile = { preferred_job_title: "Senior Engineer", desired_salary: "130000", location: "Austin, TX", work_type: "" };
  const { eligibility, compatibility } = evaluateProfileMatch({ job, profile, resumeSkills: ["React", "TypeScript", "Node"] });
  check("evaluateProfileMatch returns eligibility.passed", eligibility.passed === true);
  check("evaluateProfileMatch returns a numeric match_score from the Compatibility Engine", typeof compatibility.match_score === "number" && compatibility.match_score > 0);
  check("Compatibility Engine's own components are untouched/passed through", "skills" in compatibility.raw_components);
}
{
  const job = { title: "Remote Role", remote: false };
  const profile = { work_type: "Remote" };
  const { eligibility } = evaluateProfileMatch({ job, profile });
  check("Eligibility gate correctly fails a non-remote job against a Remote-only profile", eligibility.passed === false);
}

// ===== Signal Enrichment =====
console.log("\n=== Signal Enrichment ===");
{
  const contacts = [{ id: "c1", name: "Dana", company: "Acme Corp", status: "Connected", date_saved: "2026-08-01", generated_messages: { followUpsSent: 2 } }];
  const watchlist = [{ id: "w1", company_name: "Acme Corp", status: "dream_company" }];
  const outcomePatterns = [{ pattern_type: "industry", pattern_value: "fintech", direction: "positive", response_rate: 0.6, confidence: "high_confidence" }];
  const job = { company: "Acme Corp", industry: "Fintech" };
  const signals = computeSignalEnrichment({ job, contacts, watchlist, outcomePatterns });
  check("Detects network contact at the job's company", signals.hasNetworkContact === true);
  check("Detects watchlist membership", signals.isWatchlisted === true);
  check("Detects dream-company status via the EXISTING status column (no is_dream_company column used)", signals.isDreamCompany === true);
  check("Matches outcome pattern by industry (case-insensitive)", signals.outcomePatternSignal?.pattern_type === "industry");
  check("Flags outcome pattern as positive", signals.outcomePatternPositive === true);
}
{
  const job = { company: "NoSignal Inc", industry: "Unknown" };
  const signals = computeSignalEnrichment({ job, contacts: [], watchlist: [], outcomePatterns: [] });
  check("No signals present when nothing matches (no false positives)", !signals.hasNetworkContact && !signals.isWatchlisted && !signals.outcomePatternSignal);
}
{
  const outcomePatterns = [{ pattern_type: "company_size", pattern_value: "enterprise", direction: "negative", response_rate: 0.05, confidence: "high_confidence" }];
  const job = { company: "BigCo", companySizeEstimate: "Enterprise" };
  const signals = computeSignalEnrichment({ job, contacts: [], watchlist: [], outcomePatterns });
  check("Detects a high-confidence negative outcome pattern", signals.outcomePatternNegative === true);
}
{
  const outcomePatterns = [{ pattern_type: "company_size", pattern_value: "enterprise", direction: "negative", response_rate: 0.05, confidence: "early_signal" }];
  const job = { company: "BigCo", companySizeEstimate: "Enterprise" };
  const signals = computeSignalEnrichment({ job, contacts: [], watchlist: [], outcomePatterns });
  check("Early-signal-confidence negative pattern does NOT trigger outcomePatternNegative (too little data to act on)", signals.outcomePatternNegative === false);
}

// ===== Urgency Factors =====
console.log("\n=== Urgency Factors ===");
{
  const compatibility = { match_score: 97 };
  const signals = { hasNetworkContact: true, bestContact: { tier: "strong", contact: { name: "Dana" } }, outcomePatternPositive: true, outcomePatternSignal: { pattern_type: "industry" }, isDreamCompany: true, isWatchlisted: true };
  const job = { estimatedCloseDate: hoursFromNow(48) };
  const factors = computeUrgencyFactors({ job, compatibility, signals, now: NOW });
  const types = factors.map(f => f.type);
  check("Detects closing_soon within 72h", types.includes("closing_soon"));
  check("Detects referral_confirmed (strong tier contact)", types.includes("referral_confirmed"));
  check("Detects exceptional_match (>=95 score)", types.includes("exceptional_match"));
  check("Detects outcome_pattern_match", types.includes("outcome_pattern_match"));
  check("Dream company takes precedence over generic watchlist factor (no double-count)", types.filter(t => t === "dream_company_posting" || t === "watchlist_company_posting").length === 1);
}
{
  const job = { estimatedCloseDate: hoursFromNow(200) }; // too far out
  const factors = computeUrgencyFactors({ job, compatibility: { match_score: 50 }, signals: { hasNetworkContact: false }, now: NOW });
  check("No closing_soon factor when the deadline is beyond 72h", !factors.some(f => f.type === "closing_soon"));
}

// ===== Confidence Tier =====
console.log("\n=== Confidence Tier ===");
{
  const tier = computeConfidenceTier({ compatibility: { match_score: 20, raw_components: { salary: null } }, signals: {} });
  check("Low match, no signals -> early_signal", tier === "early_signal");
}
{
  const tier = computeConfidenceTier({
    compatibility: { match_score: 70, raw_components: { salary: 0.9 } },
    signals: { outcomePatternPositive: true, hasNetworkContact: false },
  });
  check("Good match + outcome pattern + good salary (no timing) -> emerging", tier === "emerging");
}
{
  const tier = computeConfidenceTier({
    compatibility: { match_score: 75, raw_components: { salary: 0.85 } },
    signals: { outcomePatternPositive: true },
    timingSignal: { favorable: true },
  });
  check("Match + outcome + timing + salary all present -> high_confidence", tier === "high_confidence");
}
{
  const tier = computeConfidenceTier({
    compatibility: { match_score: 80, raw_components: { salary: 1 } },
    signals: { hasNetworkContact: true, isWatchlisted: true, outcomePatternPositive: true },
  });
  check("Referral + watchlist + outcome pattern all present -> exceptional (rare convergence)", tier === "exceptional");
}

// ===== Alert Tier Assignment =====
console.log("\n=== Alert Tier Assignment ===");
{
  const eligibility = { passed: false, gates: [{ passed: false, reason: "Not remote" }] };
  const r = assignAlertTier({ compatibility: { match_score: 90 }, eligibility, signals: {}, urgencyFactors: [], confidenceTier: "early_signal" });
  check("Failed eligibility gate -> discarded regardless of match score", r.tier === "discarded");
}
{
  const eligibility = { passed: true, gates: [] };
  const signals = { outcomePatternNegative: true, outcomePatternSignal: { pattern_type: "industry" } };
  const r = assignAlertTier({ compatibility: { match_score: 90 }, eligibility, signals, urgencyFactors: [], confidenceTier: "early_signal" });
  check("Negative outcome pattern -> discarded regardless of match score", r.tier === "discarded");
}
{
  const eligibility = { passed: true, gates: [] };
  const r = assignAlertTier({ compatibility: { match_score: CONFIDENCE_FLOOR - 1 }, eligibility, signals: {}, urgencyFactors: [], confidenceTier: "early_signal" });
  check("Below confidence floor -> discarded", r.tier === "discarded");
}
{
  const eligibility = { passed: true, gates: [] };
  const urgencyFactors = [{ type: "closing_soon" }, { type: "referral_confirmed" }];
  const r = assignAlertTier({ compatibility: { match_score: 80 }, eligibility, signals: {}, urgencyFactors, confidenceTier: "emerging" });
  check(">=2 simultaneous urgency factors -> critical", r.tier === "critical");
}
{
  const eligibility = { passed: true, gates: [] };
  const urgencyFactors = [{ type: "closing_soon" }];
  const r = assignAlertTier({ compatibility: { match_score: 80 }, eligibility, signals: {}, urgencyFactors, confidenceTier: "exceptional" });
  check("Exceptional confidence + closing deadline -> critical (even with only 1 urgency factor)", r.tier === "critical");
}
{
  const eligibility = { passed: true, gates: [] };
  const urgencyFactors = [{ type: "watchlist_company_posting" }];
  const r = assignAlertTier({ compatibility: { match_score: 80 }, eligibility, signals: {}, urgencyFactors, confidenceTier: "emerging" });
  check("Exactly 1 urgency factor -> high", r.tier === "high");
}
{
  const eligibility = { passed: true, gates: [] };
  const r = assignAlertTier({ compatibility: { match_score: 80 }, eligibility, signals: {}, urgencyFactors: [], confidenceTier: "exceptional" });
  check("Exceptional confidence, no urgency factors -> high (not critical, no deadline)", r.tier === "high");
}
{
  const eligibility = { passed: true, gates: [] };
  const r = assignAlertTier({ compatibility: { match_score: 80 }, eligibility, signals: {}, urgencyFactors: [], confidenceTier: "emerging" });
  check("Good match, no urgency, non-exceptional confidence -> curated", r.tier === "curated");
}

// ===== Stretch Classification =====
console.log("\n=== Stretch Opportunity ===");
{
  check("70% skills match -> stretch", isStretchOpportunity({ compatibility: { raw_components: { skills: 0.7 } } }) === true);
  check("100% skills match -> NOT stretch (fully qualified)", isStretchOpportunity({ compatibility: { raw_components: { skills: 1 } } }) === false);
  check("50% skills match -> NOT stretch (below 70% floor)", isStretchOpportunity({ compatibility: { raw_components: { skills: 0.5 } } }) === false);
  check("null skills (no resume) -> NOT stretch, not fabricated", isStretchOpportunity({ compatibility: { raw_components: { skills: null } } }) === false);
}

// ===== Diversity Constraint =====
console.log("\n=== Diversity Constraint ===");
{
  const candidates = [
    { id: 1, tier: "high", industry: "fintech", companySizeEstimate: "mid" },
    { id: 2, tier: "high", industry: "fintech", companySizeEstimate: "mid" },
    { id: 3, tier: "high", industry: "fintech", companySizeEstimate: "mid" }, // 3rd in same group -- should be held
    { id: 4, tier: "curated", industry: "healthcare", companySizeEstimate: "small" },
    { id: 5, tier: "critical", industry: "fintech", companySizeEstimate: "mid" }, // critical bypasses
  ];
  const { included, held } = applyDiversityConstraint(candidates);
  check("Max 2 per industry+size group enforced (3rd held)", included.filter(c => c.industry === "fintech" && c.tier !== "critical").length === 2 && held.some(c => c.id === 3));
  check("Held candidate retains its original tier/score, just flagged with holdReason", held.find(c => c.id === 3).holdReason === "diversity_constraint" && held.find(c => c.id === 3).tier === "high");
  check("Critical bypasses the diversity constraint entirely", included.some(c => c.id === 5));
  check("Different industry+size group is unaffected", included.some(c => c.id === 4));
}

// ===== Balance Constraint =====
console.log("\n=== Balance Constraint ===");
{
  const candidates = [{ isStretch: true }, { isStretch: true }, { isStretch: false }, { isStretch: false }, { isStretch: false }];
  const r = applyBalanceConstraint(candidates); // 2/5 = 40% >= 20%
  check("40% stretch ratio meets the 20% minimum", r.meetsMinimum === true && r.gapNote === null);
}
{
  const candidates = [{ isStretch: false }, { isStretch: false }, { isStretch: false }, { isStretch: false }, { isStretch: false }];
  const r = applyBalanceConstraint(candidates); // 0%
  check("0% stretch ratio fails the minimum and produces a gap note (standards not lowered)", r.meetsMinimum === false && typeof r.gapNote === "string" && r.gapNote.length > 0);
}
{
  const r = applyBalanceConstraint([]);
  check("Empty pool trivially meets the minimum (no fabricated stretch entries)", r.meetsMinimum === true);
}

// ===== Delivery Caps =====
console.log("\n=== Delivery Caps ===");
{
  const tiered = [
    { tier: "critical", id: "c1" }, { tier: "critical", id: "c2" }, { tier: "critical", id: "c3" },
    { tier: "high", id: "h1" }, { tier: "high", id: "h2" }, { tier: "high", id: "h3" }, { tier: "high", id: "h4" },
    { tier: "curated", id: "cu1" },
  ];
  const r = enforceDeliveryCaps(tiered);
  check(`Critical capped at ${DAILY_CRITICAL_CAP}/day`, r.deliver.filter(c => c.tier === "critical").length === DAILY_CRITICAL_CAP);
  check(`High capped at ${DAILY_HIGH_CAP}/day`, r.deliver.filter(c => c.tier === "high").length === DAILY_HIGH_CAP);
  check("Excess Critical/High candidates are held, not discarded", r.held.length === 2 && r.held.every(c => ["daily_critical_cap", "daily_high_cap"].includes(c.holdReason)));
  check("Curated pool is separated out (not part of daily caps)", r.curatedPool.length === 1);
}
{
  const tiered = [{ tier: "critical", id: "c1" }];
  const r = enforceDeliveryCaps(tiered, { alreadyDeliveredToday: { critical: 2, high: 0 } });
  check("Respects already-delivered-today count -- 0 room left after 2 already sent", r.deliver.length === 0 && r.held.length === 1);
}
{
  // 3 critical candidates competing for a 2-slot cap: selection must be
  // deterministic (urgency-factor count, then match score), never left
  // ambiguous for the AI layer to resolve.
  const tiered = [
    { tier: "critical", id: "weak", urgencyFactors: [{}, {}], matchScore: 60 },
    { tier: "critical", id: "strongest", urgencyFactors: [{}, {}, {}], matchScore: 70 },
    { tier: "critical", id: "tiebreak-higher-score", urgencyFactors: [{}, {}], matchScore: 90 },
  ];
  const r = enforceDeliveryCaps(tiered);
  check("Over-cap Critical selection is deterministic: most urgency factors wins, ties broken by match score", r.deliver.map(c => c.id).join(",") === "strongest,tiebreak-higher-score");
  check("The excluded candidate is held (not discarded) with the cap reason, retaining its tier", r.held[0].id === "weak" && r.held[0].tier === "critical" && r.held[0].holdReason === "daily_critical_cap");
}

// ===== Full Pipeline Smoke Test =====
console.log("\n=== Full Pipeline (evaluateOpportunity) ===");
{
  const job = { id: "j1", title: "Senior Engineer", company: "Acme Corp", skills: ["React"], salaryMin: 150000, location: "Austin, TX", industry: "Fintech", estimatedCloseDate: hoursFromNow(24) };
  const profile = { preferred_job_title: "Senior Engineer", desired_salary: "140000", location: "Austin, TX", work_type: "" };
  const contacts = [{ id: "c1", name: "Dana", company: "Acme Corp", status: "Connected", date_saved: "2026-08-01", generated_messages: { followUpsSent: 3 } }];
  const watchlist = [{ id: "w1", company_name: "Acme Corp", status: "dream_company" }];
  const outcomePatterns = [{ pattern_type: "industry", pattern_value: "fintech", direction: "positive", response_rate: 0.7, confidence: "high_confidence" }];
  const result = evaluateOpportunity({ job, profile, resumeSkills: ["React", "TypeScript"], contacts, watchlist, outcomePatterns, now: NOW });
  check("Full pipeline produces a tier", ["critical", "high", "curated", "discarded"].includes(result.tier));
  check("Full pipeline produces a confidence tier", ["early_signal", "emerging", "high_confidence", "exceptional"].includes(result.confidenceTier));
  check("Full pipeline surfaces urgency factors array", Array.isArray(result.urgencyFactors) && result.urgencyFactors.length > 0);
  check("Strong signal convergence (referral+dream+outcome+closing) on this fixture resolves to critical", result.tier === "critical");
  check("No AI/narrative fields present on the result (deterministic-only boundary respected)", !("explanation" in result) && !("narrative" in result) && !("summary" in result));
}

console.log("\n=== SUMMARY ===");
const failed = results.filter(r => !r.pass);
console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED:\n${failed.map(f => "  - " + f.label).join("\n")}`);
process.exit(failed.length === 0 ? 0 : 1);
