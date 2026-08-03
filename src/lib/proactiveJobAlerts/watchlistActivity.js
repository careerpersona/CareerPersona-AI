// Proactive Job Alerts -- Watchlist Activity detection (§13's activity-state
// table). Pure function, no AI, no Supabase -- sibling deterministic engine
// to discoveryEngine.js/marketSignals.js/effectivenessMetrics.js. Feeds
// Analysis 04; detection itself needs no AI judgment, only the cross-company
// synthesis narrative does (see the Phase 3 AI Justification report).

const QUIET_THRESHOLD_DAYS = 30;
const RECENT_WINDOW_DAYS = 14;
const VOLUME_INCREASE_THRESHOLD = 3;

function normalizeCompany(name) {
  return (name || "").trim().toLowerCase();
}

// Groups already-persisted alert_candidates by company for O(1) lookup per
// watchlist entry -- a plain grouping utility, not a re-derivation of any
// score/tier (those fields are read as-is off each candidate).
export function groupCandidatesByCompany(alertCandidates) {
  const byCompany = {};
  for (const c of alertCandidates || []) {
    const key = normalizeCompany(c.company);
    if (!byCompany[key]) byCompany[key] = [];
    byCompany[key].push(c);
  }
  return byCompany;
}

export function computeWatchlistActivityStates({ watchlist, alertCandidatesByCompany, now = new Date() }) {
  return (watchlist || []).map(w => {
    const key = normalizeCompany(w.company_name);
    const candidates = alertCandidatesByCompany?.[key] || [];
    const hasNetworkJoin = candidates.some(c => c.signal_enrichments?.hasNetworkContact);
    const newPostings = candidates.filter(c => c.lifecycle_status === "discovered" || c.lifecycle_status === "evaluated");
    const recentPostings = candidates.filter(c => c.posted_at && (now - new Date(c.posted_at)) / 86400000 <= RECENT_WINDOW_DAYS);

    let signal = "quiet";
    let detail = w.last_checked_at ? `No postings in ${QUIET_THRESHOLD_DAYS}+ days` : "No activity observed yet";

    // Priority order matches §13's table: a confirmed network connection is
    // the strongest signal, then a brand-new posting, then a volume uptick.
    if (hasNetworkJoin) {
      signal = "network_contact_joined";
      detail = "A network contact now works here";
    } else if (newPostings.length > 0) {
      signal = "new_posting";
      detail = `${newPostings.length} new posting${newPostings.length === 1 ? "" : "s"}`;
    } else if (recentPostings.length >= VOLUME_INCREASE_THRESHOLD) {
      signal = "volume_increase";
      detail = `${recentPostings.length} postings in the last ${RECENT_WINDOW_DAYS} days`;
    }

    return {
      companyName: w.company_name,
      signal,
      detail,
      isDreamCompany: w.status === "dream_company",
      outcomePatternPositive: candidates.some(c => c.signal_enrichments?.outcomePatternPositive),
    };
  });
}
