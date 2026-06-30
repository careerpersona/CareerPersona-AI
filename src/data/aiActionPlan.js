import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

const TABLE = "ai_action_plans";

// Same one-active-plan-per-user pattern as useAiBriefing: loads the most
// recent row by date and upserts on the current day's date, keyed on the
// schema's existing (user_id, plan_date) unique constraint.
export function useAiActionPlan(userId) {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadedFor, setLoadedFor] = useState(undefined);

  useEffect(() => {
    let active = true;
    if (!userId) { setPlan(null); setLoadedFor(userId); setLoading(false); return; }
    setLoading(true);
    supabase.from(TABLE).select("*").eq("user_id", userId).order("plan_date", { ascending: false }).limit(1)
      .then(({ data, error }) => {
        if (!active) return;
        setPlan(!error && data && data.length ? data[0].tasks : null);
        setLoadedFor(userId);
        setLoading(false);
      });
    return () => { active = false; };
  }, [userId]);

  const save = useCallback(async (tasks) => {
    if (!userId) return;
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabase
      .from(TABLE)
      .upsert({ user_id: userId, plan_date: today, tasks }, { onConflict: "user_id,plan_date" });
    if (error) throw error;
  }, [userId]);

  return { plan, loading, loadedFor, save };
}
