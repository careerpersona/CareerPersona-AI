import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

const TABLE = "salary_research";

const toRow = (userId, form, results) => ({
  user_id: userId,
  job_title: form.jobTitle || "",
  location: form.location || null,
  experience_level: form.experience || null,
  skills: form.skills || null,
  company_type: form.company || null,
  results: results || null,
});

const fromRow = (r) => ({
  form: {
    jobTitle: r.job_title || "",
    location: r.location || "",
    experience: r.experience_level || "",
    skills: r.skills || "",
    company: r.company_type || "",
  },
  results: r.results || null,
});

// The existing UI only ever has one active salary search per user (form +
// AI results, edited and re-run in place), so this upserts a single row
// rather than modeling a list — mirrors the prior single-slot localStorage behavior.
export function useSalaryResearch(userId) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const rowIdRef = useRef(null);

  useEffect(() => {
    let active = true;
    if (!userId) { setData(null); setLoading(false); rowIdRef.current = null; return; }
    setLoading(true);
    supabase.from(TABLE).select("*").eq("user_id", userId).order("updated_at", { ascending: false }).limit(1)
      .then(({ data: rows, error }) => {
        if (!active) return;
        if (!error && rows && rows.length) {
          rowIdRef.current = rows[0].id;
          setData(fromRow(rows[0]));
        } else {
          rowIdRef.current = null;
          setData(null);
        }
        setLoading(false);
      });
    return () => { active = false; };
  }, [userId]);

  const save = useCallback(async (form, results) => {
    if (!userId) return;
    const row = toRow(userId, form, results);
    if (rowIdRef.current) {
      const { error } = await supabase.from(TABLE).update(row).eq("id", rowIdRef.current);
      if (error) throw error;
    } else {
      const { data: inserted, error } = await supabase.from(TABLE).insert(row).select().single();
      if (error) throw error;
      rowIdRef.current = inserted.id;
    }
  }, [userId]);

  return { data, loading, save };
}
