// Proactive Job Alerts -- frontend data layer. Read-only: this feature has no
// manual "Run Analysis" trigger (unlike Referral/Outcome Intelligence) -- the
// blueprint's own design is a passive, scheduled experience ("the platform
// watches for you"), and Phase 4 already executes all 6 analyses server-side
// in worker.js's scheduled() handler. The frontend only ever reads what the
// Delivery Pipeline already persisted; it never calls askClaude itself.
//
// (Phase 3 originally exported 3 frontend-callable askClaude wrapper
// functions here, mirroring Referral Intelligence's manual-trigger pattern.
// Once Phase 4 established server-side scheduled execution, those became
// dead code -- nothing calls them, and keeping them would misleadingly imply
// a supported manual-trigger path that doesn't exist. Removed; their pure
// prompt-building logic they wrapped still lives on, correctly, in
// src/lib/proactiveJobAlerts/aiPrompts.js, consumed only by worker.js now.)

import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

// Alerts joined with their source candidate row (one Supabase REST call via
// PostgREST's implicit foreign-table embedding on alerts.candidate_id) +
// every evaluated candidate (for Discovery Coverage stats and the "Why
// Didn't I See This?" / "Explain Priority Changed" lookups) + persisted
// market_signals rows (watchlist/market/effectiveness/timing narratives).
export function useProactiveAlerts(userId) {
  const [alerts, setAlerts] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [marketSignals, setMarketSignals] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!userId) { setAlerts([]); setCandidates([]); setMarketSignals([]); setLoading(false); return; }
    setLoading(true);
    const [alertsRes, candidatesRes, signalsRes] = await Promise.all([
      supabase.from("alerts").select("*, alert_candidates(*)").eq("user_id", userId).order("delivered_at", { ascending: false }),
      supabase.from("alert_candidates").select("*").eq("user_id", userId),
      supabase.from("market_signals").select("*").eq("user_id", userId).order("observed_at", { ascending: false }),
    ]);
    setAlerts(!alertsRes.error && alertsRes.data ? alertsRes.data : []);
    setCandidates(!candidatesRes.error && candidatesRes.data ? candidatesRes.data : []);
    setMarketSignals(!signalsRes.error && signalsRes.data ? signalsRes.data : []);
    setLoading(false);
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  return { alerts, candidates, marketSignals, loading, refresh };
}

// "Why Didn't I See This?" (§17) and "Explain Why Priority Changed" (§18)
// share the exact same lookup: both are pure reads of an already-persisted
// alert_candidates row's deterministic fields (discard_reason, alert_tier,
// previous_tier, tier_change_reason, lifecycle_status). Neither makes an AI
// call -- there is nothing to interpret, only a fact already computed by the
// Discovery Engine to display, which is the strongest possible form of the
// AI Explanation Rule ("AI must never invent what happened"): here, there is
// no AI in the loop for these two tools at all.
export function useAlertCandidateLookup(userId) {
  const [result, setResult] = useState({ status: "idle", candidate: null });

  const lookup = useCallback(async (jobId) => {
    if (!userId || !jobId) return;
    setResult({ status: "loading", candidate: null });
    const { data, error } = await supabase.from("alert_candidates").select("*").eq("user_id", userId).eq("job_id", jobId).maybeSingle();
    setResult({ status: "done", candidate: !error && data ? data : null });
  }, [userId]);

  const reset = useCallback(() => setResult({ status: "idle", candidate: null }), []);

  return { ...result, lookup, reset };
}
