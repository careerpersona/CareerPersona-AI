import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

// Application Outcome Intelligence's platform-memory table (see blueprint §2). Other
// Premium modules will eventually read this table directly rather than importing this
// hook -- that cross-module consumption sweep is a separate, later phase.
export function useOutcomePatterns(userId) {
  const [patterns, setPatterns] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!userId) { setPatterns([]); setLoading(false); return; }
    setLoading(true);
    const { data, error } = await supabase
      .from("outcome_patterns").select("*").eq("user_id", userId);
    setPatterns(!error && data ? data : []);
    setLoading(false);
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Upserts computed patterns, first reading existing rows to carry `previous_direction`
  // forward -- this is what powers "the AI changed its mind" detection (blueprint §9).
  const savePatterns = useCallback(async (userId2, computedPatterns) => {
    if (!userId2 || !computedPatterns?.length) return;
    const { data: existing } = await supabase
      .from("outcome_patterns").select("pattern_type,pattern_value,direction").eq("user_id", userId2);
    const priorDirection = new Map((existing || []).map(p => [`${p.pattern_type}:${p.pattern_value}`, p.direction]));
    const now = new Date().toISOString();
    const rows = computedPatterns.map(p => ({
      user_id: userId2,
      pattern_type: p.pattern_type,
      pattern_value: p.pattern_value,
      direction: p.direction,
      stability: p.stability,
      confidence: p.confidence,
      response_rate: p.response_rate,
      sample_size: p.sample_size,
      data_completeness: p.data_completeness,
      last_updated: now,
      previous_direction: priorDirection.get(`${p.pattern_type}:${p.pattern_value}`) || null,
    }));
    const { error } = await supabase.from("outcome_patterns")
      .upsert(rows, { onConflict: "user_id,pattern_type,pattern_value" });
    if (error) throw error;
    await refresh();
  }, [refresh]);

  return { patterns, loading, savePatterns, refresh };
}

export function useOutcomeAnalyses(userId) {
  const [analyses, setAnalyses] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!userId) { setAnalyses([]); setLoading(false); return; }
    setLoading(true);
    const { data, error } = await supabase
      .from("outcome_analyses").select("*").eq("user_id", userId).order("generated_at", { ascending: false });
    setAnalyses(!error && data ? data : []);
    setLoading(false);
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  const saveAnalysis = useCallback(async (userId2, record) => {
    if (!userId2) return;
    const { data, error } = await supabase.from("outcome_analyses").insert({
      user_id: userId2,
      period_start: record.periodStart,
      period_end: record.periodEnd,
      application_count: record.applicationCount,
      outcomes_logged_count: record.outcomesLoggedCount,
      confidence_tier: record.confidenceTier,
      analysis: record.analysis,
    }).select().single();
    if (error) throw error;
    await refresh();
    return data;
  }, [refresh]);

  return { analyses, latest: analyses[0] || null, loading, saveAnalysis, refresh };
}

export function useRecommendationEvaluations(userId) {
  const [evaluations, setEvaluations] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!userId) { setEvaluations([]); setLoading(false); return; }
    setLoading(true);
    const { data, error } = await supabase
      .from("recommendation_evaluations").select("*").eq("user_id", userId).order("applied_at", { ascending: false });
    setEvaluations(!error && data ? data : []);
    setLoading(false);
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  // 30 days from now, or next analysis run -- whichever comes first is enforced by the
  // evaluation sweep (see runOutcomeAnalysis), not here; this just stamps the due date.
  const markApplied = useCallback(async (userId2, { recommendationText, targetMetric, metricBefore }) => {
    if (!userId2) return;
    const appliedAt = new Date();
    const dueAt = new Date(appliedAt.getTime() + 30 * 86400000);
    const { error } = await supabase.from("recommendation_evaluations").insert({
      user_id: userId2,
      recommendation_text: recommendationText,
      target_metric: targetMetric,
      applied_at: appliedAt.toISOString(),
      evaluation_due_at: dueAt.toISOString(),
      metric_before: metricBefore ?? null,
    });
    if (error) throw error;
    await refresh();
  }, [refresh]);

  return { evaluations, loading, markApplied, refresh };
}
