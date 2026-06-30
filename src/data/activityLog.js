import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

const TABLE = "activity_log";

const fromRow = (r) => ({ id: r.id, action: r.description, time: new Date(r.created_at).toLocaleString() });

// The existing Dashboard "AI Activity" card just shows the last 10 actions
// as freeform text — no categorization in the UI — so every entry is logged
// under one generic action_type and the human-readable text goes in description.
export function useActivityLog(userId) {
  const [activity, setActivity] = useState([]);

  const refresh = useCallback(async () => {
    if (!userId) { setActivity([]); return; }
    const { data, error } = await supabase
      .from(TABLE).select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(10);
    if (!error && data) setActivity(data.map(fromRow));
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  const logActivity = useCallback(async (action) => {
    if (!userId) return;
    const optimistic = { id: `pending-${Date.now()}`, action, time: new Date().toLocaleString() };
    setActivity(prev => [optimistic, ...prev].slice(0, 10));
    const { error } = await supabase.from(TABLE).insert({ user_id: userId, action_type: "ai_activity", description: action });
    if (error) console.error("logActivity failed", error);
  }, [userId]);

  return { activity, logActivity };
}
