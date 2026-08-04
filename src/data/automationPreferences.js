import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

const TABLE = "automation_preferences";

// Automation preference read/write for the current user -- RLS-scoped
// (auth.uid() = user_id), so this runs client-side directly, unlike the
// actual budget CHECK (checkAndConsumeAutomationBudget), which requires
// service-role and lives in worker.js only (see src/lib/platform/aiBudget.js's
// header comment for why). setPreference is the ONLY way this value ever
// changes -- there is no code path anywhere that writes it automatically;
// per the locked blueprint, the user is the only entity that controls it.
export function useAutomationPreference(userId, featureKey) {
  const [value, setValue] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!userId || !featureKey) { setValue(0); setLoading(false); return; }
    setLoading(true);
    const { data, error } = await supabase
      .from(TABLE).select("value").eq("user_id", userId).eq("feature_key", featureKey).maybeSingle();
    setValue(!error && data ? data.value : 0);
    setLoading(false);
  }, [userId, featureKey]);

  useEffect(() => { refresh(); }, [refresh]);

  const setPreference = useCallback(async (newValue) => {
    if (!userId || !featureKey) return;
    const { error } = await supabase.from(TABLE)
      .upsert({ user_id: userId, feature_key: featureKey, value: newValue }, { onConflict: "user_id,feature_key" });
    if (error) throw error;
    setValue(newValue);
  }, [userId, featureKey]);

  return { value, loading, setPreference, refresh };
}
