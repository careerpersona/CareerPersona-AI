import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

const TABLE = "company_watchlist";

export function useCompanyWatchlist(userId) {
  const [watchlist, setWatchlist] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    if (!userId) { setWatchlist([]); setLoading(false); return; }
    setLoading(true);
    supabase
      .from(TABLE)
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (!active) return;
        setWatchlist(!error && data ? data : []);
        setLoading(false);
      });
    return () => { active = false; };
  }, [userId]);

  const add = useCallback(async (companyName, status = "watching") => {
    if (!userId || !companyName?.trim()) return;
    const { data, error } = await supabase
      .from(TABLE)
      .upsert({ user_id: userId, company_name: companyName.trim(), status }, { onConflict: "user_id,company_name" })
      .select()
      .single();
    if (error) throw error;
    setWatchlist(prev => {
      const exists = prev.find(c => c.company_name.toLowerCase() === companyName.trim().toLowerCase());
      if (exists) return prev.map(c => c.id === exists.id ? { ...c, status } : c);
      return [data, ...prev];
    });
    return data;
  }, [userId]);

  const remove = useCallback(async (id) => {
    if (!userId) return;
    const { error } = await supabase.from(TABLE).delete().eq("id", id).eq("user_id", userId);
    if (error) throw error;
    setWatchlist(prev => prev.filter(c => c.id !== id));
  }, [userId]);

  const updateStatus = useCallback(async (id, status) => {
    if (!userId) return;
    const { error } = await supabase.from(TABLE).update({ status }).eq("id", id).eq("user_id", userId);
    if (error) throw error;
    setWatchlist(prev => prev.map(c => c.id === id ? { ...c, status } : c));
  }, [userId]);

  const updateNotes = useCallback(async (id, notes) => {
    if (!userId) return;
    const { error } = await supabase.from(TABLE).update({ notes }).eq("id", id).eq("user_id", userId);
    if (error) throw error;
    setWatchlist(prev => prev.map(c => c.id === id ? { ...c, notes } : c));
  }, [userId]);

  return { watchlist, loading, add, remove, updateStatus, updateNotes };
}
