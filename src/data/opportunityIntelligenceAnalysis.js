import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

const TABLE = "opportunity_intelligence_analysis";

// One AI opportunity analysis per user per day — loads the most recent row and
// upserts on the current date, keyed on the (user_id, analysis_date) unique
// constraint. Same pattern as jobIntelligence.js/careerProgress.js. Named
// distinctly from data/opportunityIntelligence.js (the Company Watchlist
// hook, an unrelated existing module also used by OpportunityPage) to avoid
// colliding with it.
export function useOpportunityIntelligenceAnalysis(userId) {
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadedFor, setLoadedFor] = useState(undefined);

  useEffect(() => {
    let active = true;
    if (!userId) { setAnalysis(null); setLoadedFor(userId); setLoading(false); return; }
    setLoading(true);
    supabase.from(TABLE).select("*").eq("user_id", userId).order("analysis_date", { ascending: false }).limit(1)
      .then(({ data, error }) => {
        if (!active) return;
        setAnalysis(!error && data && data.length ? data[0].content : null);
        setLoadedFor(userId);
        setLoading(false);
      });
    return () => { active = false; };
  }, [userId]);

  const save = useCallback(async (content) => {
    if (!userId) return;
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabase
      .from(TABLE)
      .upsert({ user_id: userId, analysis_date: today, content }, { onConflict: "user_id,analysis_date" });
    if (error) throw error;
  }, [userId]);

  return { analysis, loading, loadedFor, save };
}
