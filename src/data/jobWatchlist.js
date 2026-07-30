import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

// Job Tracker (job-level half) -- see Job Tracker Blueprint. Deliberately its
// own table and its own hook, independent of saved_jobs, smart_apply_queue,
// and applications. This module must never write to any of those tables.
const TABLE = "job_watchlist";

const toRow = (job, userId) => ({
  user_id: userId,
  job_id: job.id || job.job_id,
  job_title: job.title,
  company: job.company,
  location: job.location || null,
  salary_min: job.salaryMin ?? null,
  salary_max: job.salaryMax ?? null,
  employment_type: job.employmentType || null,
  remote: !!job.remote,
  description: job.description || null,
  apply_url: job.applyUrl || null,
});

export function useJobWatchlist(userId) {
  const [watchlist, setWatchlist] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!userId) { setWatchlist([]); setLoading(false); return; }
    setLoading(true);
    const { data, error } = await supabase
      .from(TABLE).select("*").eq("user_id", userId).order("created_at", { ascending: false });
    setWatchlist(!error && data ? data : []);
    setLoading(false);
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Idempotent: tracking an already-tracked job just refreshes its snapshot
  // rather than erroring, via the unique(user_id, job_id) upsert conflict.
  const add = useCallback(async (job) => {
    if (!userId || !(job.id || job.job_id)) return;
    const { data, error } = await supabase
      .from(TABLE)
      .upsert(toRow(job, userId), { onConflict: "user_id,job_id" })
      .select()
      .single();
    if (error) throw error;
    setWatchlist(prev => {
      const exists = prev.some(w => w.job_id === data.job_id);
      return exists ? prev.map(w => (w.job_id === data.job_id ? data : w)) : [data, ...prev];
    });
    return data;
  }, [userId]);

  const remove = useCallback(async (id) => {
    if (!userId) return;
    const { error } = await supabase.from(TABLE).delete().eq("id", id).eq("user_id", userId);
    if (error) throw error;
    setWatchlist(prev => prev.filter(w => w.id !== id));
  }, [userId]);

  // Applies detected field changes (salary, description, status) to a
  // tracked job row -- used by the passive change-detection sync when a
  // fresh search resurfaces a job already being tracked. `patch.status`, if
  // present, is always one of Job Tracker's own values ("watching" /
  // "closed") -- never anything from the Application Tracker's vocabulary.
  const applyChange = useCallback(async (id, patch) => {
    if (!userId) return;
    const stamped = { ...patch, last_checked_at: new Date().toISOString() };
    const { error } = await supabase.from(TABLE).update(stamped).eq("id", id).eq("user_id", userId);
    if (error) throw error;
    setWatchlist(prev => prev.map(w => (w.id === id ? { ...w, ...stamped } : w)));
  }, [userId]);

  return { watchlist, loading, add, remove, applyChange, refresh };
}
