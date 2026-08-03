// Proactive Job Alerts -- Discovery Engine. Deterministic only, per the
// locked blueprint (https://claude.ai/code/artifact/779890b3-2265-42d7-b86f-94e78d2d56db,
// architecture-locked July 2026) and this phase's explicit boundary: source
// aggregation, profile matching, signal enrichment, tier assignment,
// constraint filtering. No AI calls, no narrative text, no Supabase -- pure
// functions only, same discipline as scoringEngine.js and the Compatibility
// Engine. Narrative explanation ("Why This Is Urgent", "Why Priority
// Changed") is Analysis 01/06's job (a later phase), never this module's.
//
// Reuses existing intelligence rather than duplicating it (§21 Rule: reuse
// before creating new; one responsibility per module):
//  - Profile Matching        -> Career Compatibility Engine (src/lib/compatibility)
//  - Network/watchlist signals -> Referral Intelligence's scoringEngine.js
//    (a read-only consumer, per the locked Referral Scoring Ownership Rule --
//    this module never recomputes a contact match or relationship score)
//  - Outcome-history signal  -> Outcome Intelligence's outcome_patterns rows
//    (passed in already-computed; this module never re-derives pattern math)
//
// "Dream company" is read directly off company_watchlist.status ===
// 'dream_company' -- no separate boolean column exists or is needed (see the
// migration file's own header note for the full reasoning).

import { computeCompatibility, evaluateEligibility } from "../compatibility/index.js";
import { matchContactsToCompany, computeRelationshipStrength } from "../referralIntelligence/scoringEngine.js";

// ── Source Aggregation ───────────────────────────────────────────────────────

function fingerprint(job) {
  return `${(job.company || "").trim().toLowerCase()}|${(job.title || "").trim().toLowerCase()}`;
}

// Dedupe by posting ID first (exact source match), then by a company+title
// fingerprint (catches the same role re-posted under a different ID, or
// mirrored across Adzuna and RapidAPI).
export function deduplicateOpportunities(postings) {
  const seenIds = new Set();
  const seenFingerprints = new Set();
  const deduped = [];
  for (const job of postings || []) {
    const id = job?.id || job?.job_id;
    if (!id) continue;
    if (seenIds.has(id)) continue;
    const fp = fingerprint(job);
    if (seenFingerprints.has(fp)) continue;
    seenIds.add(id);
    seenFingerprints.add(fp);
    deduped.push(job);
  }
  return deduped;
}

// Short-circuits before any scoring work -- a job the user already applied to
// (via applications or saved_jobs) should never re-enter the pipeline.
export function filterAlreadyApplied(postings, appliedJobIds) {
  const applied = new Set(appliedJobIds || []);
  return (postings || []).filter(p => !applied.has(p?.id || p?.job_id));
}

// ── Profile Matching ─────────────────────────────────────────────────────────
// Delegates entirely to the Career Compatibility Engine -- title/skills/
// salary/location scoring is that engine's single implementation. This
// function adds nothing of its own beyond calling it; "experience level fit"
// (named in the blueprint's Profile Matching description) has no dedicated
// component in either engine today -- approximated by the title/skills
// components already present, consistent with the Compatibility Engine's own
// documented v1 scope, not a new gap introduced here.
export function evaluateProfileMatch({ job, profile, resumeSkills, skillDictionary }) {
  const eligibility = evaluateEligibility({ job, profile });
  const compatibility = computeCompatibility({ job, profile, resumeSkills, skillDictionary });
  return { eligibility, compatibility };
}

// ── Signal Enrichment ────────────────────────────────────────────────────────

function normalizeCompany(name) {
  return (name || "").trim().toLowerCase();
}

// Reads already-computed outcome pattern rows (from computeAllPatterns() or
// the persisted outcome_patterns table) -- never recomputes pattern math.
function findOutcomePatternSignal({ job, outcomePatterns }) {
  const candidates = (outcomePatterns || []).filter(p =>
    (p.pattern_type === "company_size" && job.companySizeEstimate && p.pattern_value === String(job.companySizeEstimate).trim().toLowerCase()) ||
    (p.pattern_type === "industry" && job.industry && p.pattern_value === String(job.industry).trim().toLowerCase())
  );
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => (b.direction === "positive") - (a.direction === "positive") || (b.response_rate || 0) - (a.response_rate || 0))[0];
}

export function computeSignalEnrichment({ job, contacts, watchlist, outcomePatterns }) {
  const networkMatches = matchContactsToCompany(job.company, contacts || []);
  const bestContact = networkMatches.length
    ? [...networkMatches].map(c => ({ contact: c, ...computeRelationshipStrength(c) })).sort((a, b) => b.score - a.score)[0]
    : null;
  const watchlistEntry = (watchlist || []).find(w => normalizeCompany(w.company_name) === normalizeCompany(job.company)) || null;
  const outcomePatternSignal = findOutcomePatternSignal({ job, outcomePatterns });

  return {
    hasNetworkContact: !!bestContact,
    bestContact,
    isWatchlisted: !!watchlistEntry,
    isDreamCompany: watchlistEntry?.status === "dream_company",
    outcomePatternSignal,
    outcomePatternPositive: outcomePatternSignal?.direction === "positive",
    outcomePatternNegative: outcomePatternSignal?.direction === "negative" && outcomePatternSignal?.confidence !== "early_signal",
  };
}

// ── Urgency Factors (§3's trigger table, transcribed directly) ──────────────
export function computeUrgencyFactors({ job, compatibility, signals, now = new Date() }) {
  const factors = [];
  if (job.estimatedCloseDate) {
    const hoursLeft = (new Date(job.estimatedCloseDate) - now) / 3600000;
    if (hoursLeft > 0 && hoursLeft <= 72) {
      factors.push({ type: "closing_soon", value: Math.round(hoursLeft), ts: now.toISOString() });
    }
  }
  if (signals.hasNetworkContact && signals.bestContact?.tier === "strong") {
    factors.push({ type: "referral_confirmed", value: signals.bestContact.contact.name, ts: now.toISOString() });
  }
  if ((compatibility?.match_score ?? 0) >= 95) {
    factors.push({ type: "exceptional_match", value: compatibility.match_score, ts: now.toISOString() });
  }
  if (signals.outcomePatternPositive) {
    factors.push({ type: "outcome_pattern_match", value: signals.outcomePatternSignal?.pattern_type, ts: now.toISOString() });
  }
  if (signals.isDreamCompany) {
    factors.push({ type: "dream_company_posting", ts: now.toISOString() });
  } else if (signals.isWatchlisted) {
    factors.push({ type: "watchlist_company_posting", ts: now.toISOString() });
  }
  return factors;
}

// ── Confidence Tier (§4) ─────────────────────────────────────────────────────
// early_signal | emerging | high_confidence | exceptional. A DIFFERENT
// concept from the Compatibility Engine's own Low/Medium/High "confidence"
// (which measures data coverage for the match score alone) -- this tier
// measures how certain the platform is the opportunity is a genuine fit, from
// multiple independent signals converging. timingSignal is optional and
// defaults to unavailable, since Timing Intelligence (Analysis 06, a later
// phase) may not have run yet -- absence degrades gracefully to "no timing
// signal," never blocks tier computation.
export function computeConfidenceTier({ compatibility, signals, timingSignal = null }) {
  const matchScore = compatibility?.match_score ?? 0;
  const salaryRaw = compatibility?.raw_components?.salary ?? null;
  const salaryGood = salaryRaw != null && salaryRaw >= 0.8;
  const profileMatchGood = matchScore >= 60;
  const outcomeGood = !!signals.outcomePatternPositive;
  const timingGood = timingSignal?.favorable === true;
  const referralPath = !!signals.hasNetworkContact;
  const watchlistCompany = !!signals.isWatchlisted;

  // "All signals plus: referral path exists, watchlist company, outcome
  // pattern says strong hire rate" -- rare convergence, per §4.
  if (referralPath && watchlistCompany && outcomeGood) return "exceptional";
  // "Multiple independent signals align: profile match + outcome pattern +
  // timing + salary" -- all four factors present.
  if (profileMatchGood && outcomeGood && timingGood && salaryGood) return "high_confidence";
  // "Profile-to-JD deep match; 3+ outcome pattern signals; salary within
  // range" -- approximated as profile match + at least one of
  // (outcome/referral/timing) + salary not actively bad.
  if (profileMatchGood && (outcomeGood || referralPath || timingGood) && salaryRaw !== 0) return "emerging";
  return "early_signal";
}

// ── Alert Tier Assignment (§3, §10) ──────────────────────────────────────────
// critical | high | curated | discarded. Purely rule-based against §3's
// trigger table -- never an AI judgment call. Narrative ("Why This Is
// Urgent") is Analysis 01's job, not this function's; `reason` here is an
// internal audit trail, not user-facing copy.
export const CONFIDENCE_FLOOR = 30;

export function assignAlertTier({ compatibility, eligibility, signals, urgencyFactors, confidenceTier }) {
  if (!eligibility.passed) {
    return { tier: "discarded", reason: `Failed eligibility gate: ${eligibility.gates.find(g => !g.passed)?.reason || "unknown"}` };
  }
  if (signals.outcomePatternNegative) {
    return { tier: "discarded", reason: `Outcome pattern shows a negative signal for this company profile (${signals.outcomePatternSignal.pattern_type})` };
  }
  const matchScore = compatibility?.match_score ?? 0;
  if (matchScore < CONFIDENCE_FLOOR) {
    return { tier: "discarded", reason: `Match score ${matchScore} below confidence floor (${CONFIDENCE_FLOOR})` };
  }

  const count = urgencyFactors.length;
  // "Produced only when >=2 urgency factors are present simultaneously" (§10).
  if (count >= 2) {
    return { tier: "critical", reason: `${count} urgency factors present simultaneously: ${urgencyFactors.map(f => f.type).join(", ")}` };
  }
  // "Exceptional... Always Critical or High" (§4) -- Critical when there's an
  // active closing deadline, High otherwise (handled below).
  if (confidenceTier === "exceptional" && urgencyFactors.some(f => f.type === "closing_soon")) {
    return { tier: "critical", reason: "Exceptional confidence with a closing deadline" };
  }
  // "1 strong urgency factor or 2+ moderate signals present" (§10).
  if (count === 1) {
    return { tier: "high", reason: `Urgency factor present: ${urgencyFactors[0].type}` };
  }
  if (confidenceTier === "exceptional") {
    return { tier: "high", reason: "Exceptional confidence, no active urgency deadline" };
  }
  return { tier: "curated", reason: "Good fit without urgency drivers" };
}

// ── Stretch Opportunity Classification (§7 Balance Constraint) ──────────────
// Meets >=70% but not 100% of skill requirements -- read directly off the
// Compatibility Engine's own skills component, never re-derived independently.
export function isStretchOpportunity({ compatibility }) {
  const skillsScore = compatibility?.raw_components?.skills;
  return skillsScore != null && skillsScore >= 0.7 && skillsScore < 1;
}

// ── Post-Scoring Constraint Pass (§7) ────────────────────────────────────────
// Runs on an already-tiered, already-scored candidate list. Never modifies an
// individual candidate's score -- only decides inclusion/holding for a
// specific digest. Held candidates keep their tier and score; they roll to
// the next eligible digest, they are not discarded.

// Diversity: max N (default 2) opportunities from the same industry+company-
// size combination in a single daily digest. Critical bypasses this entirely
// (§7: "the only binding limit on urgency-tier opportunities" is the daily cap).
export function applyDiversityConstraint(candidates, { maxPerGroup = 2 } = {}) {
  const counts = new Map();
  const included = [];
  const held = [];
  for (const c of candidates) {
    if (c.tier === "critical") { included.push(c); continue; }
    const key = `${(c.industry || "unknown").toLowerCase()}|${(c.companySizeEstimate || "unknown").toLowerCase()}`;
    const count = counts.get(key) || 0;
    if (count < maxPerGroup) {
      counts.set(key, count + 1);
      included.push(c);
    } else {
      held.push({ ...c, holdReason: "diversity_constraint" });
    }
  }
  return { included, held };
}

// Balance: >=20% of a Curated weekly pipeline must be stretch opportunities.
// Never lowers standards to force it -- an unmet minimum is surfaced as a gap
// note, not fabricated by relaxing the stretch definition or the tier floor.
export function applyBalanceConstraint(curatedCandidates, { minStretchRatio = 0.2 } = {}) {
  const stretch = curatedCandidates.filter(c => c.isStretch);
  const nonStretch = curatedCandidates.filter(c => !c.isStretch);
  const actualRatio = curatedCandidates.length ? stretch.length / curatedCandidates.length : 0;
  return {
    candidates: curatedCandidates,
    stretchCount: stretch.length,
    nonStretchCount: nonStretch.length,
    actualRatio,
    meetsMinimum: curatedCandidates.length === 0 || actualRatio >= minStretchRatio,
    gapNote: curatedCandidates.length > 0 && actualRatio < minStretchRatio
      ? `Only ${Math.round(actualRatio * 100)}% of this week's Curated pool are stretch opportunities (target ${Math.round(minStretchRatio * 100)}%). No standards were lowered to fill the gap.`
      : null,
  };
}

// ── Hard Delivery Caps (§3, §21 Rule 5) ──────────────────────────────────────
// "Hard limits are hard... enforced at the database write level, not at
// presentation layer." This is that enforcement point -- the function a
// delivery layer (Phase 4's Worker cron handler) must call before ever
// writing an `alerts` row.
export const DAILY_CRITICAL_CAP = 2;
export const DAILY_HIGH_CAP = 3;
export const WEEKLY_CURATED_MIN = 5;
export const WEEKLY_CURATED_MAX = 10;

// When more candidates qualify for a tier than the daily cap allows, WHICH
// ones actually get delivered is still a deterministic "candidate selection"
// decision (one of this engine's locked responsibilities) -- never left for
// the AI layer to pick. Sorts by urgency-factor count, then match score, so
// the selection is reproducible and explainable without needing a judgment
// call. The AI layer (Phase 3) only ever narrates the already-selected set.
function rankForDelivery(candidates) {
  return [...candidates].sort((a, b) =>
    (b.urgencyFactors?.length ?? 0) - (a.urgencyFactors?.length ?? 0) ||
    (b.matchScore ?? 0) - (a.matchScore ?? 0)
  );
}

export function enforceDeliveryCaps(tieredCandidates, { alreadyDeliveredToday = { critical: 0, high: 0 } } = {}) {
  const byTier = { critical: [], high: [], curated: [], discarded: [] };
  for (const c of tieredCandidates) (byTier[c.tier] || byTier.discarded).push(c);
  byTier.critical = rankForDelivery(byTier.critical);
  byTier.high = rankForDelivery(byTier.high);

  const criticalRoom = Math.max(0, DAILY_CRITICAL_CAP - alreadyDeliveredToday.critical);
  const highRoom = Math.max(0, DAILY_HIGH_CAP - alreadyDeliveredToday.high);

  const deliverCritical = byTier.critical.slice(0, criticalRoom);
  const heldCritical = byTier.critical.slice(criticalRoom).map(c => ({ ...c, holdReason: "daily_critical_cap" }));
  const deliverHigh = byTier.high.slice(0, highRoom);
  const heldHigh = byTier.high.slice(highRoom).map(c => ({ ...c, holdReason: "daily_high_cap" }));

  return {
    deliver: [...deliverCritical, ...deliverHigh],
    held: [...heldCritical, ...heldHigh],
    curatedPool: byTier.curated,
    discarded: byTier.discarded,
  };
}

// ── Full Pipeline (composition only -- no new logic) ─────────────────────────
// Source Aggregation -> Profile Matching -> Signal Enrichment -> Tier
// Assignment, for one job. The Constraint Pass (diversity/balance) and
// Delivery Caps run separately, across a whole scored batch, once per digest
// -- see applyDiversityConstraint/applyBalanceConstraint/enforceDeliveryCaps.
export function evaluateOpportunity({ job, profile, resumeSkills, skillDictionary, contacts, watchlist, outcomePatterns, timingSignal, now }) {
  const { eligibility, compatibility } = evaluateProfileMatch({ job, profile, resumeSkills, skillDictionary });
  const signals = computeSignalEnrichment({ job, contacts, watchlist, outcomePatterns });
  const urgencyFactors = computeUrgencyFactors({ job, compatibility, signals, now });
  const confidenceTier = computeConfidenceTier({ compatibility, signals, timingSignal });
  const { tier, reason } = assignAlertTier({ compatibility, eligibility, signals, urgencyFactors, confidenceTier });
  const isStretch = isStretchOpportunity({ compatibility });

  return {
    job,
    eligibility,
    compatibility,
    signals,
    urgencyFactors,
    confidenceTier,
    tier,
    tierReason: reason,
    isStretch,
    matchScore: compatibility.match_score,
    industry: job.industry,
    companySizeEstimate: job.companySizeEstimate,
  };
}
