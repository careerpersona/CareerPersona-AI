import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

const TABLE = "ai_briefings";

// The existing UI shows one active briefing per user (regenerated in place),
// so this loads the most recent row by date and upserts on the current day's
// date — repeated "Regenerate" clicks on the same day update that one row,
// while a new calendar day naturally starts a new row (table is keyed on
// (user_id, briefing_date), already unique in the schema).
//
// `loadedFor` tracks which userId the current briefing/loading actually
// belong to, so a consumer gating on "loading just became false" can't be
// fooled by a stale render from the previous (e.g. undefined) user.
export function useAiBriefing(userId) {
  const [briefing, setBriefing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadedFor, setLoadedFor] = useState(undefined);

  useEffect(() => {
    let active = true;
    if (!userId) { setBriefing(null); setLoadedFor(userId); setLoading(false); return; }
    setLoading(true);
    supabase.from(TABLE).select("*").eq("user_id", userId).order("briefing_date", { ascending: false }).limit(1)
      .then(({ data, error }) => {
        if (!active) return;
        setBriefing(!error && data && data.length ? data[0].content : null);
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
      .upsert({ user_id: userId, briefing_date: today, content }, { onConflict: "user_id,briefing_date" });
    if (error) throw error;
  }, [userId]);

  return { briefing, loading, loadedFor, save };
}
