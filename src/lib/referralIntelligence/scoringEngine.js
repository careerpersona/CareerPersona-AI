// Deterministic scoring for Referral Intelligence. Pure functions only -- no
// Supabase, no AI calls (same discipline as src/lib/outcomeIntelligence/patternEngine.js).
//
// LOCKED (2026-08-02): this is the single implementation of referral scoring in the
// codebase. No other module (Opportunity Intelligence, Smart Apply Auto Mode, Daily
// Briefing, Today's Action Plan, or any future Premium feature) may compute its own
// referral score -- every consumer imports these functions.

const STATUS_ENGAGEMENT = {
  "Connected": 1.0,
  "Met": 0.85,
  "Replied": 0.6,
  "Waiting for Reply": 0.3,
  "No Response": 0.15,
  "Not Contacted": 0.1,
};

// Recency half-life: 60 days. Interpretive choice (no exact constant was specified) --
// longer than Outcome Intelligence's 30-day half-life, since interpersonal warmth
// decays slower than job-search timing signals.
function recencyWeight(dateStr, now) {
  if (!dateStr) return null;
  const days = (now - new Date(dateStr)) / 86400000;
  if (days < 0) return 1;
  return Math.pow(0.5, days / 60);
}

const TIER_THRESHOLDS = [
  { min: 85, tier: "strong" },
  { min: 60, tier: "warm" },
  { min: 30, tier: "warming" },
  { min: 0, tier: "cold" },
];
function tierFor(score) {
  return TIER_THRESHOLDS.find(t => score >= t.min).tier;
}

// The single ranking implementation for anything this engine scores -- every consumer
// (this file's own computeCompanyReadiness, the AI payload builder, the UI's Warmest
// Contacts list) must call this instead of writing its own comparator, so scoring,
// tiering, and ranking all stay owned by one deterministic engine.
export function rankByScore(list) {
  return [...list].sort((a, b) => b.score - a.score);
}

// Per-contact relationship strength (0-100) + tier. Missing dimensions are excluded
// from both numerator and denominator (true renormalization, matching the
// Compatibility Engine's pattern), not zero-filled.
export function computeRelationshipStrength(contact) {
  const now = new Date();
  const dims = [];

  const engagement = STATUS_ENGAGEMENT[contact.status] ?? STATUS_ENGAGEMENT["Not Contacted"];
  dims.push({ weight: 0.40, raw: engagement });

  const recency = recencyWeight(contact.lastFollowUpAt || contact.dateSaved, now);
  if (recency != null) dims.push({ weight: 0.30, raw: recency });

  const followUps = contact.followUpsSent || 0;
  const investment = Math.min(1, 0.2 + followUps * 0.2);
  dims.push({ weight: 0.30, raw: investment });

  const totalWeight = dims.reduce((s, d) => s + d.weight, 0);
  const weightedSum = dims.reduce((s, d) => s + d.weight * d.raw, 0);
  const score = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 100) : 0;

  return { contactId: contact.id, score, tier: tierFor(score) };
}

// Case-insensitive exact company-name match -- the single, centralized implementation.
// Replaces the two independent inline copies previously in OpportunityPage (Better Job
// Opportunities badging + the old Referral Opportunities card). Same limitation as
// before (no fuzzy matching for name variants like "Acme" vs "Acme Corp") -- centralizing
// doesn't fix that, it just stops there being two copies of the same limitation.
export function matchContactsToCompany(companyName, contacts) {
  if (!companyName) return [];
  const target = companyName.trim().toLowerCase();
  return (contacts || []).filter(c => c.company && c.company.trim().toLowerCase() === target);
}

// Per-company readiness (0-100), only meaningful once the company has BOTH a contact
// and a target signal (watchlist entry or a saved/applied job there) -- that joint
// condition is this score's own availability gate.
export function computeCompanyReadiness({ companyName, contacts, watchlistEntry, hasSavedOrAppliedJob, referralPattern }) {
  const matchedContacts = matchContactsToCompany(companyName, contacts);
  const hasTarget = !!watchlistEntry || !!hasSavedOrAppliedJob;
  if (!matchedContacts.length || !hasTarget) return null;

  const dims = [];
  dims.push({ weight: 0.40, raw: 1 }); // contact coverage -- binary, already gated above

  const targetStrength = watchlistEntry?.status === "dream_company" ? 1 : watchlistEntry ? 0.7 : 0.5;
  dims.push({ weight: 0.30, raw: targetStrength });

  if (referralPattern && typeof referralPattern.response_rate === "number") {
    dims.push({ weight: 0.30, raw: Math.min(1, referralPattern.response_rate) });
  }

  const totalWeight = dims.reduce((s, d) => s + d.weight, 0);
  const weightedSum = dims.reduce((s, d) => s + d.weight * d.raw, 0);
  const score = Math.round((weightedSum / totalWeight) * 100);

  const bestContact = rankByScore(
    matchedContacts.map(c => ({ contact: c, ...computeRelationshipStrength(c) }))
  )[0];

  return { companyName, score, tier: tierFor(score), contacts: matchedContacts, bestContact };
}

// Every distinct company the user is targeting -- from the watchlist, saved jobs, or
// applications (any status; referral targeting isn't a statistical question the way
// Outcome Intelligence's exclusions are, so no filtering beyond "the user showed
// interest here"). Deduplicated by lowercased company name.
export function computeTargetCompanies({ watchlist, savedJobs, applications }) {
  const byName = new Map();
  (watchlist || []).forEach(w => {
    const key = (w.company_name || "").trim().toLowerCase();
    if (!key) return;
    byName.set(key, { companyName: w.company_name, watchlistEntry: w, hasSavedOrAppliedJob: byName.get(key)?.hasSavedOrAppliedJob || false });
  });
  [...(savedJobs || []), ...(applications || [])].forEach(j => {
    const name = j.company;
    const key = (name || "").trim().toLowerCase();
    if (!key) return;
    const existing = byName.get(key);
    byName.set(key, { companyName: existing?.companyName || name, watchlistEntry: existing?.watchlistEntry || null, hasSavedOrAppliedJob: true });
  });
  return [...byName.values()];
}

// Availability for the three AI narrative sections (see buildReferralIntelligencePayload).
// Decided in code, never by the AI -- per the locked Data-Driven Availability rule.
// `targetCompanies` = computeTargetCompanies() output; `companyReadinessList` = one
// computeCompanyReadiness() result per target company (nulls included, for gap detection).
export function computeReferralAvailability({ contacts, targetCompanies, companyReadinessList }) {
  const hasAnyContact = (contacts || []).length > 0;
  const readyCompanies = (companyReadinessList || []).filter(Boolean);
  const targetsWithoutContact = (targetCompanies || []).filter(tc => !matchContactsToCompany(tc.companyName, contacts).length);
  return {
    topOpportunities: readyCompanies.length > 0,
    outreachTiming: hasAnyContact,
    relationshipBuilding: targetsWithoutContact.length > 0,
  };
}
